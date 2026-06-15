import { isDOMEventTrigger, SYNTHETIC_TRIGGERS, resolveTarget } from "./reactive-attributes";

// ─── Trigger parsing for lvt-fx: attributes ─────────────────────────────────

const FX_LIFECYCLE_SET = new Set(["pending", "success", "error", "done"]);

// Tracks elements whose entry animation has already played. Kept as a
// module-level WeakSet (rather than stashed on the DOM node) so it's
// type-safe and automatically cleaned up when elements are GC'd.
//
// Semantic: once per element lifetime. An element added to this set will
// NEVER animate again, even if the same node is updated in place. This is
// intentional — lvt-fx:animate is an entry animation, not a per-update
// flash. Morphdom creates fresh DOM nodes for newly-inserted range items
// (which are not in the set, so they animate) while reusing nodes for
// in-place updates (already in the set, so they skip). Use cases that
// want a visible pulse on every update should reach for lvt-fx:highlight.
let animatedElements = new WeakSet<Element>();

// Tracks the prior value of the watched attribute for each element using
// `lvt-fx:scroll="reset-on:<attr>"`. We can't stash the prior value as a
// data-* attribute — morphdom would diff against it and constantly fight
// the reset. WeakMap auto-cleans when the element is GC'd.
let scrollResetPriors = new WeakMap<Element, string | null>();

// Active timers for `lvt-fx:auto-click="<delay-ms>:<button-name>"`. Stored
// keyed by element so we can detect: (a) element re-renders unchanged →
// don't re-arm, (b) spec changed → cancel + re-arm, (c) element removed →
// cancel. Strong Map (not WeakMap) so we can iterate for the disconnected-
// element sweep on each render pass.
//
// Leak management: cleanup of stale entries depends on render continuity —
// `handleAutoClickDirectives` runs the sweep on every render pass, so an
// element removed between renders is collected on the next one. If the
// page stops rendering entirely (e.g. websocket dies and is never
// reconnected) while elements still have timers, those entries hold
// strong refs until tear-down. In practice the timer's own fire-time
// `isConnected` guard makes any leftover harmless — it would skip the
// `.click()` for a disconnected node — but the Map itself remains.
let autoClickTimers = new Map<
  Element,
  { timer: ReturnType<typeof setTimeout>; spec: string }
>();

/**
 * Test-only: reset the module-level animatedElements WeakSet. Required
 * for tests that reuse the same DOM nodes across cases — without this,
 * an element animated in case 1 would be silently skipped in case 2.
 * Production code should never call this.
 *
 * The double-underscore prefix and the `@internal` tag signal that this
 * is not part of the public API. The `@internal` tag is only enforced
 * when TypeScript's API Extractor (or equivalent) is configured to
 * strip it from generated `.d.ts` files — this project does not
 * currently run API Extractor, so the tag is aspirational enforcement
 * backed by the `__` naming convention and this docstring.
 *
 * @internal
 */
export function __resetAnimatedElementsForTesting(): void {
  animatedElements = new WeakSet<Element>();
  scrollResetPriors = new WeakMap<Element, string | null>();
  for (const { timer } of autoClickTimers.values()) clearTimeout(timer);
  autoClickTimers = new Map();
}

/**
 * Parse a lvt-fx:{effect}[:on:[{action}:]{trigger}] attribute name.
 * Returns the trigger type or null for implicit (no :on:).
 */
function parseFxTrigger(attrName: string): { trigger: string | null; actionName?: string } {
  // Check for :on: suffix pattern
  const onMatch = attrName.match(/^lvt-fx:\w+:on:(.+)$/i);
  if (!onMatch) return { trigger: null }; // implicit trigger

  const parts = onMatch[1].split(":");
  if (parts.length === 1) {
    return { trigger: parts[0].toLowerCase() };
  }
  // action-scoped: lvt-fx:highlight:on:save:success
  return {
    trigger: parts[parts.length - 1].toLowerCase(),
    actionName: parts.slice(0, -1).join(":"),
  };
}

/**
 * Set up DOM event listeners for lvt-fx: attributes with :on:{event} triggers.
 * Called after each DOM update to handle new elements.
 *
 * @param scanRoot - Element subtree to scan for new fx attributes.
 * @param registryRoot - Element to store listener registry on (always the wrapper).
 *                       Defaults to scanRoot for backwards compatibility.
 */
export function setupFxDOMEventTriggers(scanRoot: Element, registryRoot?: Element): void {
  const registry = registryRoot || scanRoot;
  const fxListenersKey = "__lvtFxDirectListeners";
  // Prune stale entries from elements replaced by morphdom
  const fxListeners: Array<{ el: Element; event: string; handler: EventListener; guardKey: string }> =
    ((registry as any)[fxListenersKey] || []).filter(
      (entry: { el: Element }) => entry.el.isConnected
    );

  const processEl = (el: Element) => {
    for (const attr of el.attributes) {
      if (!attr.name.startsWith("lvt-fx:")) continue;
      const parsed = parseFxTrigger(attr.name);
      if (!parsed.trigger) continue; // implicit — handled by normal directive flow
      if (FX_LIFECYCLE_SET.has(parsed.trigger)) continue; // lifecycle — handled by event listeners
      if (SYNTHETIC_TRIGGERS.has(parsed.trigger)) continue; // click-away etc.

      // It's a DOM event trigger
      const listenerKey = `__lvt_fx_${attr.name}`;
      if ((el as any)[listenerKey]) continue; // already attached

      const effect = attr.name.match(/^lvt-fx:(\w+)/i)?.[1];
      if (!effect) continue;

      const attrNameCapture = attr.name;
      const listener = () => {
        if (!el.hasAttribute(attrNameCapture)) return; // attr removed by morphdom
        const currentValue = el.getAttribute(attrNameCapture) || "";
        const targetEl = resolveTarget(el) as HTMLElement;
        applyFxEffect(targetEl, effect, currentValue);
      };
      el.addEventListener(parsed.trigger, listener);
      (el as any)[listenerKey] = listener;
      fxListeners.push({ el, event: parsed.trigger, handler: listener, guardKey: listenerKey });
    }
  };

  // Process scan root element itself then descendants (avoids spreading NodeList)
  processEl(scanRoot);
  scanRoot.querySelectorAll("*").forEach(processEl);

  (registry as any)[fxListenersKey] = fxListeners;
}

/**
 * Remove direct DOM event listeners registered by setupFxDOMEventTriggers.
 * Call on disconnect to prevent stale listeners across reconnects.
 */
export function teardownFxDOMEventTriggers(rootElement: Element): void {
  const fxListenersKey = "__lvtFxDirectListeners";
  const listeners: Array<{ el: Element; event: string; handler: EventListener; guardKey: string }> | undefined =
    (rootElement as any)[fxListenersKey];
  if (listeners) {
    listeners.forEach(({ el, event, handler, guardKey }) => {
      el.removeEventListener(event, handler);
      delete (el as any)[guardKey]; // Clear per-element marker so re-attach works on reconnect
    });
    delete (rootElement as any)[fxListenersKey];
  }
}

/**
 * Process lvt-fx: attributes triggered by a lifecycle event.
 */
export function processFxLifecycleAttributes(
  rootElement: Element,
  lifecycle: string,
  actionName?: string,
): void {
  const processEl = (el: Element) => {
    for (const attr of el.attributes) {
      if (!attr.name.startsWith("lvt-fx:")) continue;
      const parsed = parseFxTrigger(attr.name);
      if (!parsed.trigger || !FX_LIFECYCLE_SET.has(parsed.trigger)) continue;
      if (parsed.trigger !== lifecycle) continue;
      if (parsed.actionName && parsed.actionName !== actionName) continue;

      const effect = attr.name.match(/^lvt-fx:(\w+)/i)?.[1];
      if (!effect) continue;

      applyFxEffect(el as HTMLElement, effect, attr.value);
    }
  };
  processEl(rootElement);
  rootElement.querySelectorAll("*").forEach(processEl);
}

/**
 * Apply a visual effect to an element.
 */
function applyFxEffect(htmlElement: HTMLElement, effect: string, config: string): void {
  const computed = getComputedStyle(htmlElement);

  switch (effect) {
    case "highlight": {
      // Skip if already mid-highlight to prevent stale originalBackground capture.
      // Intentionally rate-limits to one highlight per element — overlapping triggers
      // (rapid clicks, DOM updates during animation) are coalesced rather than stacked.
      if ((htmlElement as any).__lvtHighlighting) break;
      (htmlElement as any).__lvtHighlighting = true;

      const duration = parseInt(
        computed.getPropertyValue("--lvt-highlight-duration").trim() || "500", 10
      );
      const color = computed.getPropertyValue("--lvt-highlight-color").trim() || "#ffc107";
      const originalBackground = htmlElement.style.backgroundColor;
      const originalTransition = htmlElement.style.transition;

      htmlElement.style.transition = `background-color ${duration}ms ease-out`;
      htmlElement.style.backgroundColor = color;

      setTimeout(() => {
        if (!htmlElement.isConnected) {
          htmlElement.style.backgroundColor = originalBackground;
          htmlElement.style.transition = originalTransition;
          if (htmlElement.style.length === 0) {
            htmlElement.removeAttribute("style");
          }
          (htmlElement as any).__lvtHighlighting = false;
          return;
        }
        htmlElement.style.backgroundColor = originalBackground;
        setTimeout(() => {
          if (htmlElement.isConnected) {
            htmlElement.style.transition = originalTransition;
            if (htmlElement.style.length === 0) {
              htmlElement.removeAttribute("style");
            }
          }
          (htmlElement as any).__lvtHighlighting = false;
        }, duration);
      }, 50);
      break;
    }
    case "animate": {
      // "Entry animation" semantics: play once per element lifetime. Every
      // tree update re-walks lvt-fx:* attributes, so without this guard an
      // unchanged row re-fires the animation on every patch. Morphdom
      // creates fresh DOM nodes for new rows (not in the WeakSet → animate);
      // reused nodes are already in the set and skip.
      if (animatedElements.has(htmlElement)) break;
      animatedElements.add(htmlElement);

      const duration = parseInt(
        computed.getPropertyValue("--lvt-animate-duration").trim() || "500", 10
      );
      const animation = config || "fade";

      let animationValue = "";
      switch (animation) {
        case "fade":
          animationValue = `lvt-fade-in ${duration}ms ease-out`;
          break;
        case "slide":
          animationValue = `lvt-slide-in ${duration}ms ease-out`;
          break;
        case "scale":
          animationValue = `lvt-scale-in ${duration}ms ease-out`;
          break;
        default:
          console.warn(`Unknown lvt-fx:animate mode: ${animation}`);
      }
      if (!animationValue) break;
      htmlElement.style.animation = animationValue;
      htmlElement.addEventListener("animationend", () => {
        // Only remove the animation we set. Do NOT remove
        // --lvt-animate-duration: users may have set it inline themselves
        // (e.g. style="--lvt-animate-duration: 800") to override duration,
        // and removing would wipe their intent. Clean up the style
        // attribute entirely only if nothing is left on it.
        htmlElement.style.removeProperty("animation");
        if (htmlElement.style.length === 0) {
          htmlElement.removeAttribute("style");
        }
      }, { once: true });
      break;
    }
    case "scroll": {
      const rawBehavior = computed.getPropertyValue("--lvt-scroll-behavior").trim();
      const behavior: ScrollBehavior = VALID_SCROLL_BEHAVIORS.has(rawBehavior)
        ? (rawBehavior as ScrollBehavior) : "auto";
      const threshold = parseInt(
        computed.getPropertyValue("--lvt-scroll-threshold").trim() || "100", 10
      );
      const mode = config || "bottom";

      switch (mode) {
        case "bottom":
          htmlElement.scrollTo({ top: htmlElement.scrollHeight, behavior });
          break;
        case "bottom-sticky": {
          const initialized = htmlElement.dataset.lvtScrollSticky === "1";
          if (!initialized) {
            htmlElement.dataset.lvtScrollSticky = "1";
            htmlElement.scrollTo({ top: htmlElement.scrollHeight, behavior: "instant" });
          } else {
            const isNearBottom = htmlElement.scrollHeight - htmlElement.scrollTop - htmlElement.clientHeight <= threshold;
            if (isNearBottom) htmlElement.scrollTo({ top: htmlElement.scrollHeight, behavior });
          }
          break;
        }
        case "top":
          htmlElement.scrollTo({ top: 0, behavior });
          break;
        case "into-view": {
          // Scroll the element itself into view of its nearest scrollable
          // ancestor. Useful when server-side state needs to focus the
          // user on a specific element (e.g., a freshly-selected comment).
          // Honors --lvt-scroll-behavior; defaults to centered placement so
          // the user has surrounding context.
          //
          // One-shot semantics: handleScrollDirectives fires on every render,
          // but we don't want to re-scroll the user back every time after they
          // scrolled away. A `data-lvt-iv-done` guard records that this
          // element has already been scrolled into view; the directive only
          // fires again if the attribute is removed and re-added (new element
          // or new value, e.g. jumping to a different comment).
          if (htmlElement.dataset.lvtIvDone !== "1") {
            htmlElement.scrollIntoView({ block: "center", inline: "nearest", behavior });
            htmlElement.dataset.lvtIvDone = "1";
          }
          break;
        }
        case "preserve":
          break;
        default: {
          // `reset-on:<attr-name>` — reset scrollLeft/scrollTop to 0
          // whenever the value of `<attr-name>` differs from the last
          // render. Use case: an element whose content swaps without the
          // node itself being replaced (morphdom reuse), where the
          // previous scroll position is meaningless for the new content.
          if (mode.startsWith("reset-on:")) {
            const attrName = mode.slice("reset-on:".length);
            if (!attrName) {
              console.warn(`lvt-fx:scroll="reset-on:" requires an attribute name`);
              break;
            }
            const currentValue = htmlElement.getAttribute(attrName);
            const seen = scrollResetPriors.has(htmlElement);
            if (!seen) {
              // First paint — establish the prior, don't reset. The
              // directive's semantic is "reset on *change*"; if a caller
              // has set scroll programmatically before our first sweep
              // (session restore, deep link, etc.), we must not clobber it.
              scrollResetPriors.set(htmlElement, currentValue);
            } else if (scrollResetPriors.get(htmlElement) !== currentValue) {
              scrollResetPriors.set(htmlElement, currentValue);
              htmlElement.scrollLeft = 0;
              htmlElement.scrollTop = 0;
            }
            break;
          }
          console.warn(`Unknown lvt-fx:scroll mode: ${mode}`);
        }
      }
      break;
    }
    default:
      console.warn(`Unknown lvt-fx effect: ${effect}`);
  }
}

/**
 * Set up document-level lifecycle listeners for lvt-fx: attributes with :on:{lifecycle}.
 * Called once per wrapper at connect time. Scoped to the provided root element so
 * multiple LiveTemplateClient instances on the same page don't cross-fire effects.
 * Stores listener references on the element for teardown via teardownFxLifecycleListeners.
 */
export function setupFxLifecycleListeners(rootElement: Element): void {
  const guardKey = "__lvtFxLifecycleSetup";
  if ((rootElement as any)[guardKey]) return;
  (rootElement as any)[guardKey] = true;

  const listeners: Array<{ event: string; handler: EventListener }> = [];
  const lifecycles = ["pending", "success", "error", "done"];
  lifecycles.forEach(lifecycle => {
    const handler = (e: Event) => {
      const customEvent = e as CustomEvent;
      const actionName = customEvent.detail?.action;
      processFxLifecycleAttributes(rootElement, lifecycle, actionName);
    };
    document.addEventListener(`lvt:${lifecycle}`, handler, true);
    listeners.push({ event: `lvt:${lifecycle}`, handler });
  });
  (rootElement as any).__lvtFxLifecycleListeners = listeners;
}

/**
 * Remove document-level lifecycle listeners registered by setupFxLifecycleListeners.
 * Call on disconnect to prevent listener accumulation across reconnects.
 */
export function teardownFxLifecycleListeners(rootElement: Element): void {
  const listeners: Array<{ event: string; handler: EventListener }> | undefined =
    (rootElement as any).__lvtFxLifecycleListeners;
  if (listeners) {
    listeners.forEach(({ event, handler }) => {
      document.removeEventListener(event, handler, true);
    });
    delete (rootElement as any).__lvtFxLifecycleListeners;
  }
  delete (rootElement as any).__lvtFxLifecycleSetup;
}

// ─── Implicit-trigger directive handlers (fire on every DOM update) ──────────

/**
 * Apply scroll directives on elements with lvt-fx:scroll attributes.
 * Only processes attributes WITHOUT :on: suffix (implicit trigger).
 * Configuration read from CSS custom properties:
 *   --lvt-scroll-behavior: auto | smooth (default: auto)
 *   --lvt-scroll-threshold: <number> (default: 100)
 */
const VALID_SCROLL_BEHAVIORS = new Set(["auto", "smooth", "instant"]);

export function handleScrollDirectives(rootElement: Element): void {
  rootElement.querySelectorAll("[lvt-fx\\:scroll]").forEach((element) => {
    const mode = element.getAttribute("lvt-fx:scroll");
    if (!mode) return;
    applyFxEffect(element as HTMLElement, "scroll", mode);
  });
}

/**
 * Cancel and forget all active `lvt-fx:auto-click` timers. Called from
 * the LiveTemplate client's `disconnect()` so per-session timer state
 * doesn't survive across a session boundary (the next session re-arms
 * fresh on its first render pass). Safe to call when no timers exist.
 *
 * Multi-client scope warning: the timer Map is module-level (matching
 * the existing `animatedElements` / `scrollResetPriors` pattern), so
 * this teardown cancels timers across every `LiveTemplateClient`
 * instance on the page. If two clients coexist (e.g. a layout client
 * and a widget client), disconnect order matters — the surviving
 * client's pending auto-clicks are cancelled along with the
 * disconnecting client's. Surviving clients re-arm on their next
 * render pass, but any auto-click that was about to fire mid-window
 * is lost. Per-instance scoping would solve this but is a larger
 * refactor (the existing two singletons would need the same
 * treatment) and is deferred until a real multi-client use case
 * appears.
 */
export function teardownAutoClickTimers(): void {
  for (const { timer } of autoClickTimers.values()) clearTimeout(timer);
  autoClickTimers.clear();
}

/**
 * Apply auto-click directives. `lvt-fx:auto-click="<delay-ms>:<button-name>"`
 * arms a timer when the element is first seen with this spec; on fire, the
 * directive locates a descendant `[name=<button-name>]` and synthesizes a
 * click on it — funneling through the existing event-delegation pipeline
 * so the server-side action runs identically to a user click. Use case:
 * auto-dismiss a toast/banner after N ms by clicking its existing dismiss
 * button (which already fires the dismissBanner server action).
 *
 * Idempotent across renders: an element that re-appears with the same
 * spec keeps its existing timer. A spec change cancels and re-arms. An
 * element that disappears has its timer canceled on the next render's
 * sweep (and even if the sweep doesn't run first, the fire-time
 * isConnected check skips the click).
 */
export function handleAutoClickDirectives(rootElement: Element): void {
  // Fast path: nothing armed and no matching elements → no work to do.
  // `querySelector` returns on the first hit, so this is cheaper than
  // the `querySelectorAll` below when there are no matches at all
  // (the common case for pages that don't use this directive).
  if (
    autoClickTimers.size === 0 &&
    rootElement.querySelector("[lvt-fx\\:auto-click]") === null
  ) {
    return;
  }

  // Sweep: cancel timers for elements that have disconnected OR whose
  // attribute was cleared while they remain in the DOM (e.g. the server
  // resolved the toast's dismiss state without removing the element).
  // Without this, the Map grows unbounded across renders, and a stale
  // timer could fire `.click()` on a button whose owning element no
  // longer wants the auto-action.
  for (const [element, entry] of Array.from(autoClickTimers)) {
    if (
      !element.isConnected ||
      !element.hasAttribute("lvt-fx:auto-click")
    ) {
      clearTimeout(entry.timer);
      autoClickTimers.delete(element);
    }
  }

  rootElement.querySelectorAll("[lvt-fx\\:auto-click]").forEach((element) => {
    const spec = element.getAttribute("lvt-fx:auto-click");
    if (!spec) return;

    const existing = autoClickTimers.get(element);
    if (existing && existing.spec === spec) return;
    if (existing) clearTimeout(existing.timer);

    const colonIdx = spec.indexOf(":");
    const delayStr = colonIdx > 0 ? spec.slice(0, colonIdx) : "";
    // Pre-validate as a pure integer string: parseInt is lenient and
    // would accept "200abc" as 200, silently masking a typo in the
    // attribute. Authors expect "<delay>:<name>" — anything else warns.
    const delayMs = /^\d+$/.test(delayStr) ? parseInt(delayStr, 10) : NaN;
    const name = colonIdx > 0 ? spec.slice(colonIdx + 1) : "";
    // `delayMs === 0` is intentionally allowed: it means "click on the
    // next tick after this element first appears" — a useful primitive
    // for "auto-execute action on render" patterns. Authors who want
    // visible debounce should pass a non-zero value.
    //
    // Name is restricted to characters that cannot escape the CSS
    // attribute-selector interpolation below (no quotes, brackets,
    // whitespace, or backslashes). Word characters and hyphens cover
    // every valid HTML name attribute we expect to encounter — including
    // digit-prefixed names — while keeping the selector safe. JavaScript
    // `\w` is ASCII-only (`[A-Za-z0-9_]`), so a Unicode button name
    // would warn here; revisit if i18n button naming becomes a real
    // requirement.
    if (
      !Number.isFinite(delayMs) ||
      delayMs < 0 ||
      !name ||
      !/^[\w-]+$/.test(name)
    ) {
      console.warn(
        `lvt-fx:auto-click expects "<delay-ms>:<button-name>", got: ${spec}`
      );
      // Reached when an element's spec changes from valid to malformed
      // mid-life. The valid-spec branch above already cleared its
      // existing timer; this delete removes the now-stale map entry so
      // the next render doesn't see a phantom prior spec.
      autoClickTimers.delete(element);
      return;
    }

    const timer = setTimeout(() => {
      // Intentionally NOT deleting the map entry here. Doing so would
      // make the next render pass see "no entry, attribute still set"
      // and re-arm a fresh timer, firing `.click()` a second time —
      // reachable whenever a render lands between fire and the server
      // removing the element. Leave the entry in place; the next
      // sweep cleans it up when the element disconnects or the
      // attribute is cleared. The fired timeout itself is now a no-op
      // (clearTimeout on a fired handle is harmless).
      if (!element.isConnected) return;
      // Scoped to <button>: clicking an arbitrary [name=…] match (e.g.
      // a checkbox, a text input) would have surprising side effects
      // unrelated to the action-submission semantic this directive
      // promises. Buttons are the only correct target.
      const button = element.querySelector(
        `button[name="${name}"]`
      ) as HTMLElement | null;
      if (button) button.click();
    }, delayMs);
    autoClickTimers.set(element, { timer, spec });
  });
}

/**
 * Apply highlight directives to elements with lvt-fx:highlight attributes.
 * Configuration read from CSS custom properties:
 *   --lvt-highlight-duration: <ms> (default: 500)
 *   --lvt-highlight-color: <color> (default: #ffc107)
 */
export function handleHighlightDirectives(rootElement: Element): void {
  rootElement.querySelectorAll("[lvt-fx\\:highlight]").forEach((element) => {
    const mode = element.getAttribute("lvt-fx:highlight");
    if (!mode) return;
    applyFxEffect(element as HTMLElement, "highlight", mode);
  });
}

/**
 * Apply animation directives to elements with lvt-fx:animate attributes.
 * Configuration read from CSS custom properties:
 *   --lvt-animate-duration: <ms> (default: 300)
 */
export function handleAnimateDirectives(rootElement: Element): void {
  rootElement.querySelectorAll("[lvt-fx\\:animate]").forEach((element) => {
    const animation = element.getAttribute("lvt-fx:animate");
    if (!animation) return;
    applyFxEffect(element as HTMLElement, "animate", animation);
  });

  ensureAnimateKeyframes();
}

function ensureAnimateKeyframes(): void {
  if (!document.getElementById("lvt-animate-styles")) {
    const style = document.createElement("style");
    style.id = "lvt-animate-styles";
    style.textContent = `
      @keyframes lvt-fade-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @keyframes lvt-slide-in {
        from { opacity: 0; transform: translateY(-10px); }
        to { opacity: 1; transform: translateY(0); }
      }
      @keyframes lvt-scale-in {
        from { opacity: 0; transform: scale(0.95); }
        to { opacity: 1; transform: scale(1); }
      }
    `;
    document.head.appendChild(style);
  }
}

// ─── Toast directives ────────────────────────────────────────────────────────

interface ToastMessage {
  id: string;
  title?: string;
  body?: string;
  type: "info" | "success" | "warning" | "error";
  dismissible: boolean;
  dismissMS: number;
}

// Key used to store the last processed data-pending value on each trigger element.
// Prevents showing the same batch of toasts twice if handleToastDirectives is
// called multiple times within a single update cycle (e.g. from multiple patches).
const PENDING_PROCESSED_KEY = "__lvtPendingProcessed";

/**
 * Read data-pending toast messages from server trigger elements and create
 * client-managed toast DOM. Called after each LiveTemplate DOM update.
 */
export function handleToastDirectives(rootElement: Element): void {
  rootElement
    .querySelectorAll<HTMLElement>("[data-toast-trigger]")
    .forEach((trigger) => {
      const pending = trigger.getAttribute("data-pending");
      if (!pending) return;
      // Skip if this exact batch was already processed (handles multi-patch calls)
      if ((trigger as any)[PENDING_PROCESSED_KEY] === pending) return;
      (trigger as any)[PENDING_PROCESSED_KEY] = pending;

      let messages: ToastMessage[];
      try {
        messages = JSON.parse(pending);
      } catch {
        return;
      }
      if (!Array.isArray(messages) || !messages.length) return;

      const position = trigger.getAttribute("data-position") || "top-right";
      const stack = getOrCreateToastStack(position);
      messages.forEach((msg) => {
        const el = createToastElement(msg);
        stack.appendChild(el);
        if (typeof msg.dismissMS === "number" && msg.dismissMS > 0) {
          setTimeout(() => el.remove(), msg.dismissMS);
        }
      });
    });
}

/**
 * Set up a document click listener that dismisses all visible toasts when
 * the user clicks outside the toast stack. Called once at connect time.
 */
export function setupToastClickOutside(): void {
  const key = "__lvt_toast_click_outside";
  const existing = (document as any)[key];
  if (existing) document.removeEventListener("click", existing);
  const listener = (e: Event) => {
    const stack = document.querySelector("[data-lvt-toast-stack]");
    if (!stack || stack.contains(e.target as Node)) return;
    stack.querySelectorAll("[data-lvt-toast-item]").forEach((el) => el.remove());
  };
  (document as any)[key] = listener;
  document.addEventListener("click", listener);
}

function getOrCreateToastStack(position: string): HTMLElement {
  let stack = document.querySelector(
    "[data-lvt-toast-stack]"
  ) as HTMLElement | null;
  if (!stack) {
    stack = document.createElement("div");
    stack.setAttribute("data-lvt-toast-stack", "");
    stack.setAttribute("aria-live", "polite");
    applyPositionStyles(stack, position);
    document.body.appendChild(stack);
  }
  return stack;
}

function applyPositionStyles(stack: HTMLElement, position: string): void {
  const s = stack.style;
  switch (position) {
    case "top-left":
      s.top = "1rem"; s.left = "1rem"; break;
    case "top-center":
      s.top = "1rem"; s.left = "50%"; s.transform = "translateX(-50%)"; break;
    case "bottom-right":
      s.bottom = "1rem"; s.right = "1rem"; break;
    case "bottom-left":
      s.bottom = "1rem"; s.left = "1rem"; break;
    case "bottom-center":
      s.bottom = "1rem"; s.left = "50%"; s.transform = "translateX(-50%)"; break;
    default: // top-right
      s.top = "1rem"; s.right = "1rem"; break;
  }
}

function createToastElement(msg: ToastMessage): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("role", "alert");
  el.setAttribute("data-lvt-toast-item", msg.id);
  if (msg.type) el.setAttribute("data-type", msg.type);

  const inner = document.createElement("div");
  inner.setAttribute("data-lvt-toast-content", "");

  if (msg.title) {
    const t = document.createElement("strong");
    t.textContent = msg.title;
    inner.appendChild(t);
  }
  if (msg.body) {
    const b = document.createElement("p");
    b.textContent = msg.body;
    inner.appendChild(b);
  }

  el.appendChild(inner);

  if (msg.dismissible) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-label", "Dismiss");
    btn.textContent = "×";
    btn.addEventListener("click", () => el.remove());
    el.appendChild(btn);
  }

  return el;
}

// closedShadowRoots tracks shadow roots created in "closed" mode. The
// platform makes them unreachable via `parent.shadowRoot` (it returns
// null) — closed mode's whole point is that the host's normal DOM API
// can't see them. On a re-render, without this side channel, the code
// would call attachShadow a second time on the same host, throw
// NotSupportedError, hit the catch, and silently drop the new content.
// Open roots are reachable via parent.shadowRoot, so they don't need
// the map.
//
// Module-scoped on purpose: WeakMap keys are garbage-collected with
// their hosts, so detached elements don't leak. A function-scoped map
// would forget closed roots across renders and the bug would return.
const closedShadowRoots = new WeakMap<Element, ShadowRoot>();

/**
 * Activate Declarative Shadow DOM for `<template shadowrootmode>` elements
 * that the client inserted via DOM APIs (innerHTML setter, morphdom's
 * createElement+appendChild path). The HTML parser activates declarative
 * shadow roots only at parse time or via setHTMLUnsafe / parseHTMLUnsafe;
 * a `<template shadowrootmode>` set via `.innerHTML = ...` is parked as a
 * plain template with content but no attached shadow root. This sweep
 * closes that gap so server-emitted shadow roots survive a client
 * re-render.
 *
 * For each matching template found under rootElement:
 *  - attach a shadow root on the parent (open by default; "closed" when
 *    shadowrootmode="closed");
 *  - move the template's content into the shadow root (replaceChildren
 *    accepts a DocumentFragment and re-parents its children atomically,
 *    so re-renders cleanly reset prior shadow content);
 *  - remove the template.
 *
 * Hosts that can't accept a shadow root (a small fixed set: <input>,
 * <textarea>, void elements, etc.) silently drop the template — better
 * than an unhandled exception that kills the render.
 *
 * Closed-mode roots are tracked in a module-level WeakMap so re-renders
 * can locate them (parent.shadowRoot returns null for closed roots).
 *
 * Idempotent: a re-run with no remaining templates is one qsa walk and
 * an early return (sub-millisecond on hundreds-of-rows pages).
 *
 * Known limitations:
 *
 * - Nested DSD is inert on EVERY render, not just re-renders. A
 *   `<template>`'s content lives in a DocumentFragment (`tpl.content`),
 *   not in the light DOM, and `querySelectorAll` does not descend into
 *   that fragment. So a `<template shadowrootmode>` nested inside
 *   another `<template>` is never in the qsa result. Once the outer
 *   shadow has been attached, the inner template ends up behind a
 *   shadow boundary — still unreachable. The fix would be a recursive
 *   sweep per new shadow root from within this loop.
 *
 * - Shadow-root options (`delegatesFocus`, `clonable`, `serializable`,
 *   even `mode`) are fixed at first attach. A re-render that toggles
 *   `shadowrootdelegatesfocus` on a host that already has a shadow root
 *   won't change the existing root's focus behaviour — re-attach isn't
 *   possible. Matches the HTML parser, which would have made the same
 *   one-shot decision; if the server needs to flip these flags, it
 *   needs to swap the host element entirely. The mode-mismatch case
 *   also logs a console.warn so the divergence is visible.
 */
export function handleShadowRootHydration(rootElement: Element): void {
  // Single qsa for both the empty-fast-path and the actual work — a
  // leading querySelector check would double-walk the tree when
  // templates are present. NodeList from querySelectorAll is static
  // (not live), so removing templates inside the loop doesn't disturb
  // iteration; no Array.from copy needed.
  // The selector guarantees <template> elements, so the typed qsa
  // overload removes the `as HTMLTemplateElement` cast inside the loop.
  const templates = rootElement.querySelectorAll<HTMLTemplateElement>(
    "template[shadowrootmode]"
  );
  if (templates.length === 0) return;
  for (const tpl of templates) {
    // qsa on an Element always returns descendants with a parentElement,
    // so !parent should be unreachable today. Kept as a defensive guard
    // in case a future caller passes a DocumentFragment-rooted tree
    // where the matched template could be a fragment's direct child.
    const parent = tpl.parentElement;
    if (!parent) {
      tpl.remove();
      continue;
    }
    const modeAttr = tpl.getAttribute("shadowrootmode");
    // Align with the HTML parser: only "open" and "closed" trigger
    // activation. A typo like shadowrootmode="opne" was previously
    // left in place "so the author can inspect" — but on every
    // subsequent render the qsa would re-find it, defeating the
    // fast-path advertised in the docblock. Remove it AND log a
    // console.warn so authors actually see the typo (the next morphdom
    // pass would overwrite it anyway).
    if (modeAttr !== "open" && modeAttr !== "closed") {
      console.warn(
        `livetemplate: invalid shadowrootmode=${JSON.stringify(modeAttr)}; ` +
          `expected "open" or "closed". Template removed.`,
        tpl
      );
      tpl.remove();
      continue;
    }
    const mode: ShadowRootMode = modeAttr;

    // For open roots, parent.shadowRoot is the reachable handle. For
    // closed roots, the platform returns null on purpose — consult the
    // WeakMap that we populated when we first attached the root.
    let shadow = parent.shadowRoot ?? closedShadowRoots.get(parent);
    // If the server flips shadowrootmode on a re-render (e.g. open →
    // closed), attachShadow can't be called a second time — the existing
    // mode silently wins. Warn so the author notices the mistake instead
    // of debugging mysterious focus/encapsulation behaviour later.
    if (shadow && shadow.mode !== modeAttr) {
      console.warn(
        `livetemplate: shadowrootmode changed from "${shadow.mode}" to "${modeAttr}" ` +
          `on re-render — mode is fixed at first attach and cannot be changed.`,
        parent
      );
    }
    if (!shadow) {
      try {
        // Forward all Declarative Shadow DOM attributes so the hydrated
        // root matches the one the HTML parser would build natively:
        // - shadowrootdelegatesfocus  → delegatesFocus
        // - shadowrootclonable        → clonable        (Chrome 124+)
        // - shadowrootserializable    → serializable    (Chrome 125+)
        // Unknown flags from older runtimes are silently ignored by
        // attachShadow, so we don't need a feature-detect.
        shadow = parent.attachShadow({
          mode,
          delegatesFocus: tpl.hasAttribute("shadowrootdelegatesfocus"),
          clonable: tpl.hasAttribute("shadowrootclonable"),
          serializable: tpl.hasAttribute("shadowrootserializable"),
        });
        if (mode === "closed") {
          closedShadowRoots.set(parent, shadow);
        }
      } catch (e) {
        // attachShadow throws DOMException for hosts that can't accept
        // one (void elements, <input>, <textarea>, custom elements that
        // declared a different mode, etc.). Drop the template so it
        // doesn't keep tripping this hook on every render, AND warn so
        // a developer accidentally putting shadow content on an invalid
        // host gets a console signal rather than a mysteriously empty
        // preview.
        //
        // Anything OTHER than a DOMException is a real bug (typo in the
        // options object, runtime fault); re-raise so it surfaces in the
        // console instead of getting silently masked as "unsupported
        // host".
        if (!(e instanceof DOMException)) throw e;
        console.warn(
          `livetemplate: attachShadow rejected on <${parent.tagName.toLowerCase()}> ` +
            `(${e.name}: ${e.message}). Template removed.`,
          parent
        );
        tpl.remove();
        continue;
      }
    }

    // Pass the DocumentFragment directly — replaceChildren moves its
    // children into the shadow root in one atomic platform call. Avoids
    // both the spread (which could hit call-stack argument limits on
    // very large NodeLists) and the intermediate Array.from allocation.
    shadow.replaceChildren(tpl.content);
    tpl.remove();
  }
}

// areaSelectArmed tracks the cleanup callback for every element that
// currently has a `lvt-fx:area-select` handler attached. Map (not
// WeakMap) because the sweep needs to iterate to detect elements whose
// attribute was removed by a server diff — without iteration those
// elements would keep their listeners and silently dispatch the old
// action on subsequent drags. Detached elements are cleaned up via
// the same sweep (isConnected check).
const areaSelectArmed = new Map<Element, AreaSelectEntry>();

// areaSelectWarnedParents dedupes the "parent not positioned" dev-warn
// so a user who repeatedly drags on a mis-configured element gets a
// single console message instead of one per pointerdown. WeakSet so
// detached parents don't leak.
//
// Known limitation: once a parent is in the set, the warn never fires
// again on that DOM node — even if the developer subsequently adds
// `position: relative` to fix the issue. The WeakSet is per-object
// (different DOM node = different entry), so re-mounting the parent
// resets the dedupe; in-place CSS fixes do not. Fine in practice
// (the user already saw the warn once, on the broken render).
const areaSelectWarnedParents = new WeakSet<Element>();

interface AreaSelectEntry {
  action: string;
  cleanup: () => void;
  // updateSend lets the idempotent re-arm path swap the captured
  // send callback without tearing down + rebuilding listeners. The
  // listeners close over a mutable `send` variable inside
  // attachAreaSelect; updateSend reassigns it.
  updateSend: (send: AreaSelectSendFn) => void;
}

type AreaSelectSendFn = (
  message: { action: string; data: Record<string, unknown> }
) => void;

// MIN_AREA_FRACTION filters accidental click-style gestures where the
// user meant to click, not drag. 2% of the element's rendered size is
// big enough to be intentional on touch + mouse but small enough that
// anyone seriously trying to annotate a tiny region can still do it.
const MIN_AREA_FRACTION = 0.02;

/**
 * Apply area-select directives. `lvt-fx:area-select="<actionName>"` on
 * an element (typically an `<img>` inside a positioned parent) lets
 * the user drag a rectangle locally — a `<div>` overlay tracks the
 * gesture in real time without a server round-trip — and on
 * `pointerup` dispatches a single livetemplate action with the final
 * `{x, y, w, h}` as 0..1 fractions of the element's rendered bounding
 * rect. The image's intrinsic dimensions don't matter for the
 * fractions: any uniform scale (zoom, responsive layout) preserves
 * the fraction. The consumer scales to pixels using the natural size
 * if it needs them.
 *
 * Contract:
 *  - Host's `parentElement` must establish a positioning context
 *    (`position: relative` / `absolute` / `fixed`). The overlay is
 *    `position: absolute` inside that parent so it follows the host
 *    on scroll / reflow.
 *  - Consumers usually pair this with `touch-action: none` on the
 *    host so iOS Safari doesn't interpret the drag as a pinch/scroll.
 *  - `<img>` and other natively-draggable hosts work automatically:
 *    the directive calls `preventDefault()` on `dragstart` so the
 *    browser's native drag (which would otherwise steal the gesture)
 *    is suppressed.
 *  - On pointer-cancel (e.g. system gesture, app switch), the overlay
 *    is removed and no action is dispatched — same effect as cancelling
 *    a click on `mouseleave`.
 *  - Drags smaller than `MIN_AREA_FRACTION` in BOTH dimensions are
 *    dropped — a click on the host still fires normal `click`
 *    handlers via the compatibility mouse events.
 *  - For text-bearing hosts, set `user-select: none` (the directive
 *    deliberately does NOT call `preventDefault()` on `pointerdown`
 *    so click handlers still receive the gesture; that means the
 *    browser's default text-selection-on-drag behaviour also fires
 *    unless the host opts out via CSS).
 *  - The overlay uses `z-index: var(--lvt-area-select-z-index, 9999)`.
 *    9999 is high enough for most use cases but can collide with
 *    portals / modals / drawers that also sit at a high z-index.
 *    Set `--lvt-area-select-z-index` on the host (or any ancestor)
 *    to override. Color + fill follow the same pattern via
 *    `--lvt-area-select-color` and `--lvt-area-select-fill`.
 *  - **No keyboard equivalent.** Pointer-only by design (a keyboard-
 *    selected rectangle requires a different UX — focus + arrow keys
 *    to position + arrow keys to size). Consumers needing a11y for
 *    area selection should provide a parallel form-based affordance.
 *
 * Idempotent across renders: an element re-armed with the same action
 * keeps its existing listeners. A different action causes a tear-down
 * and re-arm. Disconnected elements (and elements whose attribute was
 * cleared by a server diff) get their listeners cleaned up by the
 * sweep at the top of every call — we use a regular Map (not WeakMap)
 * specifically so the sweep can iterate.
 *
 * Module-level singleton: `areaSelectArmed` is shared across all
 * LiveTemplateClient instances in the same window. If two clients
 * ever arm the same element with different actions, the second wins
 * and the first client's send() is orphaned. Single-client use is
 * unaffected.
 */
export function handleAreaSelectDirectives(
  rootElement: Element,
  send: (message: { action: string; data: Record<string, unknown> }) => void
): void {
  // Sweep stale entries before processing the current match set:
  // disconnected elements AND elements where the attribute was
  // removed by a server diff. Without this, a previously-armed
  // element whose lvt-fx:area-select was cleared would keep its
  // listeners and silently dispatch the old action on subsequent
  // drags. Iterate via Array.from so cleanup()'s delete() doesn't
  // disturb the iterator.
  for (const [element, entry] of Array.from(areaSelectArmed)) {
    if (!element.isConnected || !element.hasAttribute("lvt-fx:area-select")) {
      entry.cleanup();
    }
  }

  const matches = rootElement.querySelectorAll<HTMLElement>(
    "[lvt-fx\\:area-select]"
  );
  if (matches.length === 0) return;

  for (const el of matches) {
    const action = el.getAttribute("lvt-fx:area-select");
    // Empty attribute → consumer almost certainly typoed; warn and
    // skip rather than dispatching to a blank action name.
    if (!action) {
      console.warn(
        `lvt-fx:area-select requires an action name, got: ${JSON.stringify(action)}`
      );
      continue;
    }
    const existing = areaSelectArmed.get(el);
    if (existing && existing.action === action) {
      // Idempotent re-arm: keep the listeners + WeakMap entry, but
      // update the captured send so a subsequent drag dispatches
      // through the latest callback (e.g. after a WebSocket
      // reconnect rebuilt the transport).
      existing.updateSend(send);
      continue;
    }
    if (existing) existing.cleanup();
    areaSelectArmed.set(el, attachAreaSelect(el, action, send));
  }
}

/**
 * Cancel area-select listeners for every armed element under root.
 * Mirrors teardownAutoClickTimers: meant for the client's disconnect /
 * destroy lifecycle so the module-level singleton doesn't outlive a
 * client that was torn down without a subsequent
 * handleAreaSelectDirectives call (e.g. network error closed the
 * socket while an element was armed). Without this, a SPA that mounts
 * + tears down livetemplate trees would leak listeners across mounts.
 */
export function teardownAreaSelectForRoot(rootElement: Element): void {
  // `contains` returns true for the node itself, so this also handles
  // the (today-impossible) case of rootElement being armed directly.
  for (const [element, entry] of Array.from(areaSelectArmed)) {
    if (rootElement.contains(element)) {
      entry.cleanup();
    }
  }
}

// iframeAutoHeightArmed tracks armed `lvt-fx:iframe-autoheight` <iframe>
// hosts. Map (not WeakMap) so the sweep can iterate to clean up elements
// whose attribute was removed by a server diff or that were detached —
// same reasoning as area-select.
const iframeAutoHeightArmed = new Map<Element, IframeAutoHeightEntry>();

interface IframeAutoHeightEntry {
  cleanup: () => void;
  // sync re-measures the iframe height from its content. Called every
  // render so a reflow that doesn't reload the srcdoc still resizes.
  sync: () => void;
}

/**
 * Apply iframe auto-height directives. `lvt-fx:iframe-autoheight` on a
 * same-origin `<iframe sandbox="allow-same-origin">` (the prereview HTML
 * preview) sizes the iframe to its content's scrollHeight on load and
 * whenever the content reflows (ResizeObserver) — iframes don't size to
 * their content. The preview is an iframe, not a shadow root, so the
 * page's own CSS (var()/@media/vw/position:sticky) resolves against a real
 * viewport (issue #26). Reading scrollHeight requires `allow-same-origin`.
 *
 * Selecting a region of the preview to comment on is handled separately,
 * by an overlay in the PARENT document (lvt-fx:region-select) — not from
 * inside the iframe: iOS Safari does not deliver iframe-internal events to
 * parent listeners, so a same-origin contentDocument tap never arrives.
 *
 * Idempotent across renders; the sweep at the top cleans up detached /
 * attribute-cleared iframes.
 */
export function handleIframeAutoHeightDirectives(rootElement: Element): void {
  for (const [element, entry] of Array.from(iframeAutoHeightArmed)) {
    if (
      !element.isConnected ||
      !element.hasAttribute("lvt-fx:iframe-autoheight")
    ) {
      entry.cleanup();
    }
  }

  const matches = rootElement.querySelectorAll<HTMLIFrameElement>(
    "iframe[lvt-fx\\:iframe-autoheight]"
  );
  for (const el of matches) {
    const existing = iframeAutoHeightArmed.get(el);
    if (existing) {
      existing.sync();
      continue;
    }
    iframeAutoHeightArmed.set(el, attachIframeAutoHeight(el));
  }
}

function attachIframeAutoHeight(
  iframe: HTMLIFrameElement
): IframeAutoHeightEntry {
  let resizeObserver: ResizeObserver | null = null;

  const applyHeight = () => {
    try {
      const doc = iframe.contentDocument;
      if (!doc?.documentElement) return;
      const h = doc.documentElement.scrollHeight;
      // Skip a 0 height: it means no layout yet (pre-load, or jsdom which
      // never lays out). A genuinely empty document stays at its default
      // height until the next `load` re-measures — fine for the preview,
      // which always has content.
      if (h > 0) iframe.style.height = `${h}px`;
    } catch {
      // contentDocument throws on a cross-origin iframe (this directive
      // expects same-origin). Isolate the failure so a misconfigured host
      // can't abort the rest of the render's directive sweep.
    }
  };

  const onLoad = () => {
    let doc: Document | null = null;
    try {
      doc = iframe.contentDocument;
    } catch {
      return; // cross-origin — nothing we can read or observe
    }
    if (!doc) return;
    resizeObserver?.disconnect();
    if (typeof ResizeObserver !== "undefined" && doc.documentElement) {
      resizeObserver = new ResizeObserver(() => applyHeight());
      resizeObserver.observe(doc.documentElement);
    }
    applyHeight();
  };

  iframe.addEventListener("load", onLoad);
  // srcdoc set before this directive ran may have already loaded.
  if (iframe.contentDocument?.readyState === "complete") onLoad();

  return {
    cleanup: () => {
      iframe.removeEventListener("load", onLoad);
      resizeObserver?.disconnect();
      iframeAutoHeightArmed.delete(iframe);
    },
    sync: () => applyHeight(),
  };
}

// urlHashArmed tracks `lvt-fx:url-hash` listeners and their last-
// mirrored hash. Same Map-not-WeakMap reasoning as area-select: the
// sweep iterates to detect elements whose attribute was removed by a
// server diff, and detached elements are cleaned up via the same
// sweep (isConnected check).
//
// Module-level singleton: shared across all LiveTemplateClient
// instances in the window. Two clients arming DIFFERENT elements
// each get their own entry; the shared window hashchange listener
// iterates the map and dispatches through every armed entry's own
// send, so a multi-client page sees each client receive its hash
// event. Teardown is scoped per root via teardownURLHashForRoot, so
// clients don't tear down each other's listeners.
//
// Same-element multi-arm is "last writer wins": the Map key is the
// element, so a second client arming the same element runs the
// existing entry's cleanup() and replaces it. The first client's
// send is orphaned. This matches area-select's behavior and is fine
// for the documented single-arm-per-element contract.
const urlHashArmed = new Map<Element, URLHashEntry>();

// urlHashWindowListener is the single window-level `hashchange`
// listener shared across all armed elements. Registered on first arm,
// removed when the armed map becomes empty. Per-element listeners
// would multi-fire for the (rare) case of multiple armed elements;
// one shared listener iterating the armed map keeps the dispatch
// count deterministic.
let urlHashWindowListener: ((e: HashChangeEvent) => void) | null = null;

interface URLHashEntry {
  action: string;
  // send is stored on the entry so the shared window listener can
  // dispatch each armed entry's action through its own transport. The
  // idempotent re-arm path mutates this field directly (via
  // updateSend), so a reconnect that rebuilt the transport is picked
  // up on the next hashchange.
  send: URLHashSendFn;
  cleanup: () => void;
  updateSend: (send: URLHashSendFn) => void;
  // currentDataHash is the last `data-lvt-url-hash` value we mirrored
  // into `location.hash` (or the value we observed on a user-initiated
  // hashchange). Comparing against the next render's data-attr lets us
  // no-op when the server re-rendered with the same hash — avoids
  // extra history entries on every keystroke.
  currentDataHash: string;
}

type URLHashSendFn = (
  message: { action: string; data: Record<string, unknown> }
) => void;

/**
 * Apply url-hash directives. `lvt-fx:url-hash="<actionName>"` plus a
 * `data-lvt-url-hash="<hash>"` attribute on an element (typically the
 * `<body>`) wires a two-way bridge between server state and
 * `location.hash`:
 *
 *  - **State → URL** (every render): if `data-lvt-url-hash` differs
 *    from `location.hash`, mirror the data-attr into the URL via
 *    `history.pushState` when the path component changed (everything
 *    before the first `:`) or `history.replaceState` when only the
 *    target (line range / anchor) changed. Replace is the right
 *    default for line scrolls so the back-button cycles between files,
 *    not between every clicked line.
 *  - **URL → State** (on `hashchange` AND initial arm): dispatch
 *    `{action: <actionName>, data: {hash: <hash>}}` so the server can
 *    parse the hash and update its state (which then renders back as
 *    a matching data-attr — closing the loop).
 *
 * The directive uses `history.pushState`/`replaceState` (not
 * `location.hash = ...`) for the state→URL direction precisely so
 * those writes do NOT fire `hashchange` — only true user-initiated
 * navigation (anchor click, address-bar edit, back-button) reaches
 * the URL→state listener. This avoids the obvious infinite loop.
 *
 * Idempotent across renders: same action → keep listener + update
 * send. Different action → cleanup + re-arm. Detached / attribute-
 * removed elements are swept on every call (same pattern as
 * area-select). The window listener is registered on first arm and
 * removed when the armed map becomes empty.
 *
 * Coexistence with `setupHashLink`: prereview-style hashes
 * (`README.md:L4`, `foo/bar.html:h-anchor`) never match a
 * `document.getElementById(...)`, so the existing dialog/popover/
 * details hash machinery silently no-ops. If a deep-link hash
 * happens to collide with an element id, both handlers will fire —
 * the server is expected to no-op on hashes that don't resolve to a
 * known file.
 *
 * **Pre-encoding contract**: `data-lvt-url-hash` must hold the hash
 * value already in URL-encoded form. The directive writes the
 * attribute verbatim into `history.pushState`/`replaceState`, so a
 * value containing spaces, `[`, `]`, `%`, or other reserved
 * characters needs to be percent-encoded by the server. The hash
 * sent to the action on `hashchange` is also passed through unmodified
 * (no decoding) — both directions are byte-exact mirrors of what's
 * in `location.hash`.
 *
 * **URL/state divergence after a non-deep-link initial load**: if
 * the user lands with a native-anchor hash (`#hero`) AND the server
 * has a selected file, the directive leaves the URL on `#hero` (case
 * b) — URL and server state diverge until the user navigates. This
 * is intentional: popovers/anchors aren't ours to overwrite. The
 * next user action that triggers a server render will re-sync only
 * once URL and state share a deep-link hash.
 *
 * **Path-only deep links require an extension**: the
 * `looksLikeDeepLinkHash` heuristic dispatches only hashes
 * containing `:`, `/`, or `.`. Extension-less root files
 * (`#Makefile`, `#Dockerfile`, `#LICENSE`) won't dispatch as
 * path-only deep links — use the line form (`#Makefile:L1`)
 * instead. The trade-off favours not clobbering native-anchor
 * machinery for single-token hashes.
 */
export function handleURLHashDirective(
  rootElement: Element,
  send: (message: { action: string; data: Record<string, unknown> }) => void
): void {
  // Sweep stale entries first — disconnected hosts AND hosts whose
  // attribute was removed by a server diff. Iterate via Array.from so
  // cleanup()'s delete() doesn't disturb the iterator.
  for (const [element, entry] of Array.from(urlHashArmed)) {
    if (
      !element.isConnected ||
      !element.hasAttribute("lvt-fx:url-hash")
    ) {
      entry.cleanup();
    }
  }

  // Match the root itself, descendants, AND the document body. The
  // url-hash directive is typically placed on `<body>`, but livetemplate
  // auto-injects its `<div data-lvt-id>` INSIDE body, so the rootElement
  // passed by the client is the wrapper div — a strict descendant of
  // body. Without the body check, a directive on `<body>` would never
  // arm. We accept body placement because URL hash is page-global
  // anyway; the directive's lifecycle is still tied to the wrapper via
  // teardownURLHashForRoot (called on disconnect of the wrapper).
  const matches: HTMLElement[] = [];
  if (
    rootElement instanceof HTMLElement &&
    rootElement.hasAttribute("lvt-fx:url-hash")
  ) {
    matches.push(rootElement);
  }
  const body = rootElement.ownerDocument?.body;
  if (
    body &&
    body !== rootElement &&
    body.hasAttribute("lvt-fx:url-hash") &&
    !matches.includes(body)
  ) {
    matches.push(body);
  }
  rootElement
    .querySelectorAll<HTMLElement>("[lvt-fx\\:url-hash]")
    .forEach((el) => {
      if (!matches.includes(el)) matches.push(el);
    });
  if (matches.length === 0) return;

  for (const el of matches) {
    const action = el.getAttribute("lvt-fx:url-hash");
    if (!action) {
      console.warn(
        `lvt-fx:url-hash requires an action name, got: ${JSON.stringify(action)}`
      );
      continue;
    }
    const dataHash = el.getAttribute("data-lvt-url-hash") || "";
    const existing = urlHashArmed.get(el);
    if (existing && existing.action === action) {
      existing.updateSend(send);
      mirrorDataAttrToLocation(existing, dataHash);
      continue;
    }
    if (existing) existing.cleanup();
    const entry = attachURLHash(el, action, send);
    urlHashArmed.set(el, entry);
    // First-arm sync: three cases, in priority order.
    const initialLocation = window.location.hash.replace(/^#/, "");
    if (
      initialLocation &&
      initialLocation !== dataHash &&
      looksLikeDeepLinkHash(initialLocation)
    ) {
      // (a) URL has a deep-link hash that differs from server state.
      // URL "wins" on initial load — dispatch so the server can
      // reconcile, and seed currentDataHash so the converging render
      // doesn't try to mirror over the user's URL.
      entry.currentDataHash = initialLocation;
      send({ action, data: { hash: initialLocation } });
    } else if (initialLocation && !looksLikeDeepLinkHash(initialLocation)) {
      // (b) URL has a non-deep-link hash (e.g. `#hero` opening a
      // popover, or a native heading anchor). Leave it alone — it
      // belongs to other machinery (setupHashLink, native scroll).
      // Seed currentDataHash so a later mirror sees the data-attr
      // as the baseline to compare against, and only writes when
      // the user navigates away from the popover/anchor.
      entry.currentDataHash = dataHash;
    } else {
      // (c) URL is empty (or already matches the server). Mirror the
      // server's hash into the URL if any.
      mirrorDataAttrToLocation(entry, dataHash);
    }
  }
}

/**
 * Cancel url-hash listeners for every armed element under root. Same
 * lifecycle role as teardownAreaSelectForRoot.
 */
export function teardownURLHashForRoot(rootElement: Element): void {
  // Includes body when body is an ancestor of rootElement and body is
  // armed — the directive accepts body placement (see the matcher in
  // handleURLHashDirective), so teardown must symmetrically clean up
  // both directions.
  //
  // Multi-client caveat: a body-armed entry is shared across all
  // LiveTemplateClient instances (Map key is the element, so only one
  // entry per body). Tearing down client A's root will therefore also
  // tear down a body listener that client B armed last — there's no
  // "owner" tracked. Acceptable for the single-client case (the
  // common deployment) and matches the same-element-multi-arm
  // last-writer-wins behavior in attachURLHash. A "fix" that
  // restricted the body-cleanup branch to client A would leak
  // client A's own body listener — don't do that without also
  // tracking entry ownership.
  const body = rootElement.ownerDocument?.body;
  for (const [element, entry] of Array.from(urlHashArmed)) {
    if (rootElement.contains(element)) {
      entry.cleanup();
      continue;
    }
    if (body && element === body && body.contains(rootElement)) {
      entry.cleanup();
    }
  }
}

// mirrorDataAttrToLocation pushes `dataHash` into `location.hash` if
// it differs from what's already in the URL. Chooses push vs replace
// by comparing the path component (everything before the first `:`)
// against the current location.hash's path: a path change is a "file
// switch" (user-meaningful back-button entry) and gets pushState;
// any other change is a target-only update (line scroll / anchor
// scroll) and gets replaceState. Updates entry.currentDataHash so a
// subsequent render with the same data-attr no-ops.
//
// Initial-mirror special case: if the URL was empty when we're
// mirroring (no prior hash to compare against), use replaceState even
// though the path-component comparison would say "changed". An empty
// URL → first server hash isn't a "navigation" — we're establishing
// the initial state. Using pushState here would let Back land the
// user on `url-without-hash`, which re-triggers the same arm and
// pushes the same hash again. Loop.
//
// Empty-dataHash special case: if the server transitions FROM a
// selected file TO no-selection (state.URLHash() returns ""), we
// would otherwise wipe location.hash entirely — including hashes the
// directive doesn't own (a popover #hero the user opened during the
// session). To stay safe, only clear when the URL currently holds a
// deep-link-shaped hash; non-deep-link hashes are left alone.
function mirrorDataAttrToLocation(entry: URLHashEntry, dataHash: string): void {
  if (entry.currentDataHash === dataHash) return;
  const currentLocation = window.location.hash.replace(/^#/, "");
  if (currentLocation === dataHash) {
    entry.currentDataHash = dataHash;
    return;
  }
  if (currentLocation !== "" && !looksLikeDeepLinkHash(currentLocation)) {
    // URL is on something not ours (popover id, native anchor) —
    // don't clobber it, regardless of what the server's data-attr
    // says. This covers BOTH the server-clears case (dataHash="")
    // and the rarer server-changes-selection-while-popover-open
    // case (dataHash transitions from one file to another while
    // the URL is parked on a non-deep-link hash).
    entry.currentDataHash = dataHash;
    return;
  }
  warnIfUnencodedHash(dataHash);
  const targetURL = dataHash ? `#${dataHash}` : window.location.pathname + window.location.search;
  const oldPath = currentLocation.split(":")[0];
  const newPath = dataHash.split(":")[0];
  // Preserve existing history.state — passing `null` would clobber
  // anything other SPA-like code on the page stores there (scroll
  // position, modal flag, etc.). The state object is independent of
  // the URL we're rewriting, so carrying it forward is the right
  // default.
  const currentState = window.history.state;
  // Empty currentLocation means we're establishing the URL from a
  // blank slate (initial render with no prior URL hash) — that's NOT
  // a back-button-meaningful navigation, so always replaceState.
  // Otherwise: a path change is a file switch (push), a target-only
  // change is a line/anchor scroll (replace).
  if (currentLocation !== "" && oldPath !== newPath) {
    window.history.pushState(currentState, "", targetURL);
  } else {
    window.history.replaceState(currentState, "", targetURL);
  }
  entry.currentDataHash = dataHash;
}

// warnIfUnencodedHash flags `data-lvt-url-hash` values containing
// characters that should be percent-encoded (raw space, `<`, `>`,
// `"`, ``` ` ```, `#`, `[`, `]`, `%`). The directive writes the
// hash verbatim into `pushState`/`replaceState`, so an unencoded
// value will silently produce a malformed URL — `location.hash`
// reads back differently from what was set. Cheap dev-time guard
// against a server-side contract slip; dedupes by value to avoid
// log spam.
//
// `%` is included because a raw `%` not followed by two hex digits
// is itself a percent-encoding error. The check is a heuristic
// (won't catch every malformed escape), but covers the common
// "forgot to encode" cases.
const urlHashUnencodedWarned = new Set<string>();

/**
 * Test-only: reset the per-page dedupe Set that suppresses repeated
 * `warnIfUnencodedHash` calls for the same hash value. Production
 * code shouldn't need this — the Set is bounded by the number of
 * unique malformed hashes — but tests that re-use the same hash
 * across cases need to clear it or the second test won't see the
 * warning. Mirrors `__resetAnimatedElementsForTesting`.
 */
export function __resetURLHashUnencodedWarnedForTesting(): void {
  urlHashUnencodedWarned.clear();
}

function warnIfUnencodedHash(hash: string): void {
  if (!hash || urlHashUnencodedWarned.has(hash)) return;
  if (/[ <>"`#\[\]]/.test(hash) || /%(?![0-9A-Fa-f]{2})/.test(hash)) {
    urlHashUnencodedWarned.add(hash);
    console.warn(
      `lvt-fx:url-hash: data-lvt-url-hash="${hash}" contains characters that should be percent-encoded. The directive writes it verbatim into history.pushState/replaceState; malformed URLs result. Server-side FormatHash (or equivalent) should percent-escape path segments and target ids before serialization.`
    );
  }
}

// looksLikeDeepLinkHash discriminates URL hashes the prereview deep-
// link grammar can produce (file path with optional :L<n> or :h-id)
// from hashes that belong to other native machinery (HTML element
// anchors, dialog/popover/details ids, etc.). Deep-link hashes always
// contain at least one of: `:` (target separator), `/` (nested path),
// or `.` (file extension). Empty → false.
//
// False positives are possible but cheap. A heading id like
// `#v1.0.0`, `#menu/item`, or `#key:value` matches this heuristic
// and will dispatch the action — but the consuming server is
// expected to no-op on hashes whose path doesn't resolve to a known
// file (prereview's SetURLHash does, via the loadDiffCached failure
// path). The cost is one wasted roundtrip per false positive, which
// is acceptable for the alternative of missing real deep links.
//
// False negatives: extension-less filenames at the repo root —
// `#Makefile`, `#Dockerfile`, `#LICENSE` — don't match this
// heuristic and won't be dispatched as path-only deep links. The
// workaround is the line-form (`#Makefile:L1`), which always
// dispatches. This trade-off is deliberate: a heuristic that
// matched single-token hashes would also clobber every native
// anchor / popover id, which is a much worse default. Consumers
// that need extension-less file deep links can build a richer
// directive on top.
function looksLikeDeepLinkHash(hash: string): boolean {
  if (!hash) return false;
  return hash.includes(":") || hash.includes("/") || hash.includes(".");
}

function attachURLHash(
  el: HTMLElement,
  action: string,
  initialSend: URLHashSendFn
): URLHashEntry {
  const entry: URLHashEntry = {
    action,
    send: initialSend,
    cleanup: () => {
      urlHashArmed.delete(el);
      if (urlHashArmed.size === 0 && urlHashWindowListener) {
        window.removeEventListener("hashchange", urlHashWindowListener);
        urlHashWindowListener = null;
      }
    },
    updateSend: (s) => {
      entry.send = s;
    },
    currentDataHash: "",
  };

  if (!urlHashWindowListener) {
    urlHashWindowListener = () => {
      const hash = window.location.hash.replace(/^#/, "");
      // Only dispatch hashes that look like deep-link targets — they
      // contain `:` (target separator), `/` (nested path), or `.`
      // (file extension). Plain element-id hashes like `#hero` or
      // `#confirm-delete-xyz` belong to the native anchor / dialog /
      // popover / details machinery (setupHashLink handles those) and
      // would otherwise be dispatched here, prompt a server no-op,
      // then get clobbered by the mirror step when the server's
      // data-attr (unchanged) doesn't match.
      //
      // Empty hash (user cleared the URL bar) is also intentionally
      // ignored. The directive treats the server as the source of
      // truth for "what's selected"; an empty URL is "user navigated
      // away from a hash" but not "deselect everything". If the user
      // wants to deselect, they use the in-app affordance
      // (clearSelection / Escape) which makes the server emit an
      // empty data-attr — at which point the mirror step propagates
      // the empty hash back to the URL.
      if (!looksLikeDeepLinkHash(hash)) return;
      // Iterate via Array.from in case a dispatched action triggers a
      // render that mutates the armed map (e.g. tears down this
      // element). Each armed entry dispatches through its OWN send +
      // action so multi-arm is deterministic — typically the body is
      // the only armed element so this is one iteration.
      for (const e of Array.from(urlHashArmed.values())) {
        // Record the user-driven hash as the new baseline so the
        // next render's mirror step doesn't immediately revert it.
        e.currentDataHash = hash;
        e.send({ action: e.action, data: { hash } });
      }
    };
    window.addEventListener("hashchange", urlHashWindowListener);
  }

  return entry;
}

// attachAreaSelect captures `send` in a mutable local so the
// idempotent re-arm path (same element, same action) can swap it via
// the returned `updateSend` callback without tearing down + rebuilding
// listeners. Listeners reference the closure-captured `send` variable
// directly, so reassigning it propagates instantly. This guards
// against the stale-closure trap a caller would hit if their `send`
// reference changed across renders — e.g. a reconnect rebuilt the
// transport.
// BoxDragResult is the final rectangle handed to a box-drag consumer when
// a real drag (above the click threshold) completes inside the host.
interface BoxDragResult {
  // Clamped drag rectangle in VIEWPORT coordinates (host-bounded). Used by
  // hit-test consumers (region-select) that compare the box against other
  // elements' getBoundingClientRect().
  left: number;
  top: number;
  right: number;
  bottom: number;
  // The same rectangle as 0..1 fractions of the host's rendered rect. Used
  // by fraction consumers (area-select on an image).
  x: number;
  y: number;
  w: number;
  h: number;
}

// attachBoxDragSelect wires the pointer-drag gesture + live overlay on a
// host element and invokes onComplete with the final rectangle when the
// user finishes a drag big enough to count as a selection (not a click).
// It owns every pointer-capture / re-entrancy / multi-touch / parent-
// positioning / off-edge-clamping subtlety; consumers differ ONLY in what
// they do with the result — area-select sends {x,y,w,h} fractions, region-
// select hit-tests the viewport box to a source line range. This is the
// shared spine; do not duplicate it.
function attachBoxDragSelect(
  el: HTMLElement,
  warnedParents: WeakSet<Element>,
  attrName: string,
  onComplete: (result: BoxDragResult) => void
): { cleanup: () => void } {
  let overlay: HTMLDivElement | null = null;
  let startClientX = 0;
  let startClientY = 0;
  let pointerId = -1;
  // Capture the parent at pointerdown time so a server diff that moves
  // the host to a NEW parent mid-drag doesn't split the drag across
  // two positioning contexts. updateOverlay positions against this
  // cached parent for the lifetime of the gesture; the overlay itself
  // stays a child of the parent we appended it to (overlay removal
  // uses overlay.parentElement, which is independent).
  let dragParent: HTMLElement | null = null;
  // Cache the host's rect at pointerdown — startClientX/Y are captured
  // in the SAME frame, so the start corner is meaningful only against
  // the rect that existed then. If a server diff repositions the host
  // mid-drag, finalize would otherwise clamp the (old-coord-system)
  // startClientX against the new rect and silently produce wrong
  // fractions. Anchoring to the start-rect keeps the dispatched
  // rectangle pinned to the visual region the user actually dragged.
  let startRect: DOMRect | null = null;

  const removeOverlay = () => {
    if (overlay) {
      // Element.remove() is a no-op if the node isn't in the DOM,
      // so we don't need the parent-null guard the older two-step
      // pattern needed.
      overlay.remove();
    }
    overlay = null;
  };

  const finalize = (e: PointerEvent | null, dispatch: boolean) => {
    if (pointerId === -1) return;
    // CRITICAL ORDER: reset pointerId + dragParent + startRect BEFORE
    // calling releasePointerCapture. Chromium fires lostpointercapture
    // SYNCHRONOUSLY during releasePointerCapture, which lands in
    // onLostCapture → finalize(null, false). Without the early reset,
    // the nested finalize sees pointerId still matching and runs to
    // completion (clearing startRect), then the outer finalize
    // resumes with startRect == null and silently drops the
    // dispatched action. Resetting first makes the nested call
    // return at the `pointerId === -1` guard, leaving outer state
    // intact.
    const capturedPointerId = pointerId;
    const rect = startRect;
    pointerId = -1;
    dragParent = null;
    startRect = null;
    try {
      el.releasePointerCapture(capturedPointerId);
    } catch {
      // Capture may already be gone (e.g. pointercancel) — ignore.
    }
    // Remove the per-gesture pointerleave fallback so a NEXT drag
    // doesn't inherit a stale listener from this one. {once: true}
    // only auto-removes if it fires; a stuck drag never fired it.
    el.removeEventListener("pointerleave", onPointerLeaveCancel);
    if (!dispatch || !e || !rect) {
      removeOverlay();
      return;
    }
    if (rect.width <= 0 || rect.height <= 0) {
      removeOverlay();
      return;
    }
    // Clamp the two corners to the rect BEFORE computing fractions so
    // a drag that escapes the element still yields a rectangle inside
    // it (x ∈ [0,1], w ∈ [0,1-x]). Otherwise a far-off-rect endpoint
    // would push w past 1 even with x already > 0.
    const rectRight = rect.left + rect.width;
    const rectBottom = rect.top + rect.height;
    const x0 = clampRange(Math.min(startClientX, e.clientX), rect.left, rectRight);
    const y0 = clampRange(Math.min(startClientY, e.clientY), rect.top, rectBottom);
    const x1 = clampRange(Math.max(startClientX, e.clientX), rect.left, rectRight);
    const y1 = clampRange(Math.max(startClientY, e.clientY), rect.top, rectBottom);
    const x = (x0 - rect.left) / rect.width;
    const y = (y0 - rect.top) / rect.height;
    const w = (x1 - x0) / rect.width;
    const h = (y1 - y0) / rect.height;
    removeOverlay();
    // Reject zero-area rectangles outright. The MIN_AREA_FRACTION
    // check below uses `&&` (drop only when BOTH dims are small) so
    // a wide-but-thin selection is preserved — but a literal
    // 60%×0 (or 0×60%) collapses to no region, can't be rendered
    // sensibly, and would divide by zero in any pixel-space
    // conversion downstream. Drop independently of the threshold.
    if (w <= 0 || h <= 0) return;
    // Drop when BOTH dimensions are below the threshold (intentional
    // `&&` — NOT `||`). A wide-but-thin drag (e.g. an underline across
    // an annotated row) or a tall-but-thin drag (e.g. a vertical
    // highlight) is a real selection in this directive's contract,
    // not an accidental click. `||` would drop those legitimate
    // gestures. The click-vs-drag boundary lives in "the rect has
    // basically no area" — that's both dims below the threshold.
    if (w < MIN_AREA_FRACTION && h < MIN_AREA_FRACTION) {
      // Treat as a click, not a drag. Don't dispatch; let normal click
      // handlers (if any) run via the platform.
      return;
    }
    // Hand the consumer both the clamped viewport box (x0,y0,x1,y1) and
    // the host-relative fractions; it decides the payload.
    onComplete({ left: x0, top: y0, right: x1, bottom: y1, x, y, w, h });
  };

  const onPointerLeaveCancel = (e: PointerEvent) => {
    // Fallback for the rare case where setPointerCapture failed: without
    // capture, pointermove + pointerup stop arriving once the pointer
    // leaves the host, freezing the overlay. Treating pointerleave as
    // a cancel keeps the overlay from getting stuck on screen.
    // Guard on pointerId — in multi-touch, a SECONDARY pointer's
    // leave shouldn't cancel the primary drag.
    if (e.pointerId !== pointerId) return;
    finalize(null, false);
  };

  // Chromium fires `dragstart` on an <img> after the first mousemove
  // following mousedown, yanking the gesture away from pointer events
  // before pointerup arrives — the overlay flashes and capture is
  // lost. preventDefault on dragstart suppresses the native image
  // drag without breaking pointer events. Cheap to attach on every
  // element type (non-img hosts simply never fire dragstart).
  const onDragStart = (e: DragEvent) => e.preventDefault();

  const onPointerDown = (e: PointerEvent) => {
    // Only primary button (left mouse / single touch / pen tip). Modifier
    // keys passed through so the server-side handler can decide what to
    // do with them via subsequent renders.
    if (!e.isPrimary || e.button !== 0) return;
    // Re-entrancy guard: if a prior drag never finished (e.g. capture
    // failed silently, then pointer left the element with no pointerup
    // ever delivered), the closed-over pointerId variable would still
    // hold the stale id. Cancel the prior drag — removing its overlay
    // and listeners — before starting a fresh one.
    if (pointerId !== -1) finalize(null, false);
    const parent = el.parentElement;
    if (!parent) return; // overlay needs a positioned container
    // Dev-time check: if the parent doesn't establish a positioning
    // context, the overlay's `position: absolute` will resolve against
    // the nearest positioned ANCESTOR — a distant element with no
    // visible relationship to the host. Result: overlay paints in
    // the wrong place with no error, just a confusing visual.
    // Check against the positive list of positioned values; the
    // default "static" and an unset/empty value both fail it (jsdom
    // returns "" for unset position). Dedupe via WeakSet so a user
    // dragging repeatedly on the same mis-configured parent gets ONE
    // console message, not one per pointerdown.
    if (!warnedParents.has(parent)) {
      const parentPos = window.getComputedStyle(parent).position;
      if (
        parentPos !== "relative" &&
        parentPos !== "absolute" &&
        parentPos !== "fixed" &&
        parentPos !== "sticky"
      ) {
        console.warn(
          `${attrName}: parentElement has no positioning context; the drag overlay will be mis-positioned. ` +
            "Add position:relative (or absolute/fixed/sticky) to the parent.",
          parent
        );
        warnedParents.add(parent);
      }
    }
    startClientX = e.clientX;
    startClientY = e.clientY;
    pointerId = e.pointerId;
    dragParent = parent;
    startRect = el.getBoundingClientRect();
    let captureOk = false;
    try {
      el.setPointerCapture(pointerId);
      captureOk = true;
    } catch {
      // Capture failure is non-fatal — without it, leaving the element
      // mid-drag will lose pointermove. Fall back to pointerleave as
      // the cancel signal so the overlay can't get stuck.
    }
    if (!captureOk) {
      el.addEventListener("pointerleave", onPointerLeaveCancel, { once: true });
    }
    overlay = document.createElement("div");
    overlay.className = "lvt-area-select-overlay";
    overlay.setAttribute("aria-hidden", "true");
    // Inline styles so the directive doesn't depend on a CSS class
    // shipped by the consumer. Consumers can override via the class
    // selector if they want a different look.
    overlay.style.cssText =
      "position:absolute;pointer-events:none;border:2px solid var(--lvt-area-select-color,#4cc2ff);" +
      "background:var(--lvt-area-select-fill,rgba(76,194,255,0.18));box-sizing:border-box;" +
      "z-index:var(--lvt-area-select-z-index,9999);";
    parent.appendChild(overlay);
    updateOverlay(e);
    // NOT calling e.preventDefault() here: doing so on pointerdown
    // suppresses the compatibility mouse events (mousedown → mouseup
    // → click), so a small-rect drag (which finalize() treats as a
    // click) would never reach the host's click handlers. The
    // directive's contract promises clicks still bubble. Text-
    // selection during drag is the consumer's responsibility — set
    // `user-select: none` on the host (the contract docs this).
  };

  const updateOverlay = (e: PointerEvent) => {
    if (!overlay) return;
    // Use the parent captured at pointerdown — if a server diff
    // moved `el` to a new parent mid-drag, re-fetching el.parentElement
    // here would compute against the new container while the overlay
    // lives in the old, paint at the wrong place for the rest of the
    // gesture.
    const parent = dragParent;
    if (!parent) return;
    const elRect = el.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    // Convert viewport coords (clientX/Y) to position:absolute CSS
    // offsets inside the parent. Three corrections, all subtracted
    // from / added to the same way for every value we compute:
    //
    //   1. parentRect.left/top — getBoundingClientRect is in viewport
    //      coords; CSS offsets are relative to the parent's box.
    //   2. parent.clientLeft/Top — position:absolute is measured from
    //      the padding box; getBoundingClientRect returns the border
    //      box. A parent with a CSS border would otherwise shift the
    //      overlay by the border width.
    //   3. parent.scrollLeft/Top — when the parent is scrolled, an
    //      element at viewport_x = parentRect.left has CSS_left =
    //      parent.scrollLeft (not 0). Without adding scroll back in,
    //      the overlay paints offset by the scroll amount.
    const borderL = parent.clientLeft;
    const borderT = parent.clientTop;
    const scrollL = parent.scrollLeft;
    const scrollT = parent.scrollTop;
    const toCSSLeft = (vx: number) => vx - parentRect.left - borderL + scrollL;
    const toCSSTop = (vy: number) => vy - parentRect.top - borderT + scrollT;
    const left = toCSSLeft(Math.min(startClientX, e.clientX));
    const top = toCSSTop(Math.min(startClientY, e.clientY));
    const width = Math.abs(e.clientX - startClientX);
    const height = Math.abs(e.clientY - startClientY);
    // Clamp to the host's rendered rect (in the same CSS coord space)
    // so a drag that runs off the edge doesn't paint outside the host.
    const minLeft = toCSSLeft(elRect.left);
    const minTop = toCSSTop(elRect.top);
    const maxRight = minLeft + elRect.width;
    const maxBottom = minTop + elRect.height;
    const clampedLeft = Math.max(minLeft, Math.min(left, maxRight));
    const clampedTop = Math.max(minTop, Math.min(top, maxBottom));
    const clampedRight = Math.max(minLeft, Math.min(left + width, maxRight));
    const clampedBottom = Math.max(minTop, Math.min(top + height, maxBottom));
    overlay.style.left = `${clampedLeft}px`;
    overlay.style.top = `${clampedTop}px`;
    overlay.style.width = `${Math.max(0, clampedRight - clampedLeft)}px`;
    overlay.style.height = `${Math.max(0, clampedBottom - clampedTop)}px`;
  };

  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    // Host removed from the DOM mid-drag (e.g. server diff replaced it).
    // Without this, the overlay would be left orphaned under the parent
    // because the host's cleanup never runs.
    if (!el.isConnected) {
      finalize(null, false);
      return;
    }
    updateOverlay(e);
  };

  const onPointerUp = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    if (!el.isConnected) {
      finalize(null, false);
      return;
    }
    finalize(e, true);
  };

  const onPointerCancel = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    finalize(e, false);
  };
  // lostpointercapture handles the rare case where the platform yanks
  // capture (OS gesture, another setPointerCapture call). Guard on
  // pointerId — another code path could call setPointerCapture for a
  // DIFFERENT pointer on the same element, and we mustn't cancel
  // our in-progress drag because of an unrelated release.
  const onLostCapture = (e: PointerEvent) => {
    if (e.pointerId === pointerId) finalize(null, false);
  };

  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointermove", onPointerMove);
  el.addEventListener("pointerup", onPointerUp);
  el.addEventListener("pointercancel", onPointerCancel);
  el.addEventListener("lostpointercapture", onLostCapture);
  el.addEventListener("dragstart", onDragStart);

  const cleanup = () => {
    el.removeEventListener("pointerdown", onPointerDown);
    el.removeEventListener("pointermove", onPointerMove);
    el.removeEventListener("pointerup", onPointerUp);
    el.removeEventListener("pointercancel", onPointerCancel);
    el.removeEventListener("lostpointercapture", onLostCapture);
    el.removeEventListener("pointerleave", onPointerLeaveCancel);
    el.removeEventListener("dragstart", onDragStart);
    finalize(null, false);
  };

  return { cleanup };
}

// attachAreaSelect wires lvt-fx:area-select on an image host: a drawn box
// dispatches the action with {x,y,w,h} as 0..1 fractions of the host's
// rendered rect (image bytes don't reflow, so a pixel rect is stable).
function attachAreaSelect(
  el: HTMLElement,
  action: string,
  initialSend: AreaSelectSendFn
): AreaSelectEntry {
  let send = initialSend;
  const handle = attachBoxDragSelect(
    el,
    areaSelectWarnedParents,
    "lvt-fx:area-select",
    (r) => send({ action, data: { x: r.x, y: r.y, w: r.w, h: r.h } })
  );
  return {
    action,
    cleanup: () => {
      handle.cleanup();
      areaSelectArmed.delete(el);
    },
    updateSend: (s) => {
      send = s;
    },
  };
}

// region-select reuses the area-select entry shape (action + cleanup +
// updateSend); the alias names that intent so the map type doesn't read
// as "a region map holding area entries".
type BoxDragEntry = AreaSelectEntry;

// regionSelectArmed / regionSelectWarnedParents mirror the area-select
// singletons (see those for the Map-not-WeakMap reasoning).
const regionSelectArmed = new Map<Element, BoxDragEntry>();
const regionSelectWarnedParents = new WeakSet<Element>();

/**
 * Apply region-select directives. `lvt-fx:region-select="<actionName>"` on
 * a transparent overlay (parent light DOM) laid over a rendered-HTML
 * preview iframe or a code view lets the user DRAW A BOX to comment on a
 * region — the same touch-capable drag as area-select, but the drawn box
 * is hit-tested to a SOURCE LINE RANGE instead of a pixel rect, so the
 * comment survives responsive reflow and round-trips with the raw view +
 * CSV (issue #26 region comments).
 *
 * The overlay's `data-surface` selects the hit-test:
 *   - "html": the box is intersected against the sibling iframe's
 *     contentDocument `[data-from]`/`[data-to]` blocks, offset by the
 *     iframe's viewport position (the auto-height iframe doesn't scroll).
 *   - "code": the box is intersected against the parent's `[data-line]`
 *     rows in the same document.
 * Either resolves to `{from, to[, side]}` and dispatches the action; a box
 * that hits no line-bearing element dispatches nothing.
 *
 * The overlay lives in the PARENT document on purpose: iOS Safari does not
 * deliver events that happen inside an iframe to a parent listener, so the
 * old in-iframe tap never arrived on a phone. A parent overlay is the same
 * event path as the file list, which works.
 *
 * Idempotent + swept exactly like area-select. The overlay's parent must
 * establish a positioning context (the shared drag spine warns if not).
 * Images keep using lvt-fx:area-select (pixel rects are stable).
 */
export function handleRegionSelectDirectives(
  rootElement: Element,
  send: AreaSelectSendFn
): void {
  for (const [element, entry] of Array.from(regionSelectArmed)) {
    if (!element.isConnected || !element.hasAttribute("lvt-fx:region-select")) {
      entry.cleanup();
    }
  }
  const matches = rootElement.querySelectorAll<HTMLElement>(
    "[lvt-fx\\:region-select]"
  );
  if (matches.length === 0) return;
  for (const el of matches) {
    const action = el.getAttribute("lvt-fx:region-select");
    if (!action) {
      console.warn(
        `lvt-fx:region-select requires an action name, got: ${JSON.stringify(action)}`
      );
      continue;
    }
    const existing = regionSelectArmed.get(el);
    if (existing && existing.action === action) {
      existing.updateSend(send);
      continue;
    }
    if (existing) existing.cleanup();
    regionSelectArmed.set(el, attachRegionSelect(el, action, send));
  }
}

/**
 * Cancel region-select listeners for every armed element under root.
 * Mirror of teardownAreaSelectForRoot for the client disconnect lifecycle.
 */
export function teardownRegionSelectForRoot(rootElement: Element): void {
  for (const [element, entry] of Array.from(regionSelectArmed)) {
    if (rootElement.contains(element)) {
      entry.cleanup();
    }
  }
}

function attachRegionSelect(
  el: HTMLElement,
  action: string,
  initialSend: AreaSelectSendFn
): BoxDragEntry {
  let send = initialSend;
  const handle = attachBoxDragSelect(
    el,
    regionSelectWarnedParents,
    "lvt-fx:region-select",
    (r) => {
      const data = resolveRegion(el, r);
      if (data) send({ action, data });
    }
  );
  return {
    action,
    cleanup: () => {
      handle.cleanup();
      regionSelectArmed.delete(el);
    },
    updateSend: (s) => {
      send = s;
    },
  };
}

type LineRange = { from: number; to: number; side?: string };

// previewIframeFor finds the iframe a region overlay covers. The overlay
// is a sibling of its iframe inside a positioned wrapper and is rendered
// immediately AFTER it, so the preceding sibling is the target. Prefer
// that over `wrapper.querySelector("iframe")`, which would silently pick
// the wrong element if the wrapper ever held more than one iframe; fall
// back to the first iframe in the wrapper only if the sibling isn't one.
function previewIframeFor(overlay: HTMLElement): HTMLIFrameElement | null {
  const prev = overlay.previousElementSibling;
  if (prev instanceof HTMLIFrameElement) return prev;
  return (
    overlay.parentElement?.querySelector<HTMLIFrameElement>("iframe") ?? null
  );
}

// resolveRegion hit-tests a drawn box (viewport coords) against the line-
// bearing elements of the overlay's target surface, returning the source
// line-range payload or null when the box hit nothing.
function resolveRegion(el: HTMLElement, box: BoxDragResult): LineRange | null {
  const surface = el.getAttribute("data-surface");
  if (surface === "html") {
    const iframe = previewIframeFor(el);
    const doc = iframe?.contentDocument;
    if (!iframe || !doc) return null;
    const fr = iframe.getBoundingClientRect();
    return lineRangeFromBox(
      doc.querySelectorAll("[data-from]"),
      box,
      fr.left,
      fr.top,
      readHTMLRange
    );
  }
  if (surface === "code") {
    const root: ParentNode = el.parentElement || document;
    return lineRangeFromBox(
      root.querySelectorAll("[data-line]"),
      box,
      0,
      0,
      readCodeRange
    );
  }
  return null;
}

// readHTMLRange reads a rendered-HTML block's source span from its
// data-from / data-to attributes (data-to defaults to data-from).
// Exported so unit tests exercise the real reader, not a copy.
export function readHTMLRange(el: Element): LineRange | null {
  const from = parseInt(el.getAttribute("data-from") || "", 10);
  if (!Number.isFinite(from) || from <= 0) return null;
  const to = parseInt(el.getAttribute("data-to") || "", 10);
  return { from, to: Number.isFinite(to) && to >= from ? to : from };
}

// readCodeRange reads a code row's source line from data-line and its diff
// side from data-side ("old" rows carry it; everything else is "new").
// Exported so unit tests exercise the real reader, not a copy.
export function readCodeRange(el: Element): LineRange | null {
  const n = parseInt(el.getAttribute("data-line") || "", 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return el.getAttribute("data-side") === "old"
    ? { from: n, to: n, side: "old" }
    : { from: n, to: n };
}

/**
 * lineRangeFromBox intersects a drawn box (viewport coords) with a set of
 * line-bearing candidate elements and returns a single-side line range of
 * those that overlap it — `from` = smallest line, `to` = largest.
 *
 * The side of the TOPMOST intersecting row fixes the range's side, and
 * rows of any OTHER side are then excluded. This matters on a diff: a
 * `del` row's data-line is its OLD line number, an `add`/context row's is
 * its NEW number — two different coordinate systems. A box that strays
 * across the add/del boundary must NOT union those into one range (it
 * would mis-anchor). Restricting to one side mirrors SelectLine's locked-
 * side invariant. Rendered HTML has no sides (all undefined), so every
 * overlapping block contributes.
 *
 * offsetX/offsetY shift each candidate's rect into the box's coordinate
 * space (the iframe's viewport origin for the html surface; 0 for code).
 * Returns null when no candidate overlaps. Exported for unit testing.
 */
export function lineRangeFromBox(
  candidates: ArrayLike<Element>,
  box: { left: number; top: number; right: number; bottom: number },
  offsetX: number,
  offsetY: number,
  readRange: (el: Element) => LineRange | null
): LineRange | null {
  // First pass: collect overlapping rows with their viewport top so the
  // topmost can fix the side before we union (a box can cross the diff's
  // add/del boundary).
  const hits: { top: number; range: LineRange }[] = [];
  for (const el of Array.from(candidates)) {
    const r = el.getBoundingClientRect();
    const top = r.top + offsetY;
    const bottom = r.bottom + offsetY;
    const left = r.left + offsetX;
    const right = r.right + offsetX;
    // Skip candidates the box doesn't overlap at all.
    if (
      right < box.left ||
      left > box.right ||
      bottom < box.top ||
      top > box.bottom
    ) {
      continue;
    }
    const range = readRange(el);
    if (range) hits.push({ top, range });
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.top - b.top);
  const side = hits[0].range.side;
  let from = Infinity;
  let to = -Infinity;
  for (const { range } of hits) {
    if (range.side !== side) continue; // exclude the other diff side
    if (range.from < from) from = range.from;
    if (range.to > to) to = range.to;
  }
  return side ? { from, to, side } : { from, to };
}

function clampRange(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n) || n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
