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
// currently has a `lvt-fx:area-select` handler attached. WeakMap keys
// are garbage-collected with their elements, so detached elements
// don't leak; the cleanup callback removes listeners + the on-screen
// overlay if a drag is mid-flight.
const areaSelectArmed = new WeakMap<Element, AreaSelectEntry>();

interface AreaSelectEntry {
  action: string;
  cleanup: () => void;
}

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
 *  - On pointer-cancel (e.g. system gesture, app switch), the overlay
 *    is removed and no action is dispatched — same effect as cancelling
 *    a click on `mouseleave`.
 *  - Drags smaller than `MIN_AREA_FRACTION` in BOTH dimensions are
 *    dropped — a click on the image still bubbles for normal handlers.
 *
 * Idempotent across renders: an element re-armed with the same action
 * keeps its existing listeners. A different action causes a tear-down
 * and re-arm. Disconnected elements have their listeners cleaned up
 * implicitly via WeakMap GC + pointerup happening only while the
 * element is still in the DOM.
 */
export function handleAreaSelectDirectives(
  rootElement: Element,
  send: (message: { action: string; data: Record<string, unknown> }) => void
): void {
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
    if (existing && existing.action === action) continue;
    if (existing) existing.cleanup();
    areaSelectArmed.set(el, attachAreaSelect(el, action, send));
  }
}

function attachAreaSelect(
  el: HTMLElement,
  action: string,
  send: (message: { action: string; data: Record<string, unknown> }) => void
): AreaSelectEntry {
  let overlay: HTMLDivElement | null = null;
  let startClientX = 0;
  let startClientY = 0;
  let pointerId = -1;

  const removeOverlay = () => {
    if (overlay && overlay.parentElement) {
      overlay.parentElement.removeChild(overlay);
    }
    overlay = null;
  };

  const finalize = (e: PointerEvent | null, dispatch: boolean) => {
    if (pointerId === -1) return;
    try {
      el.releasePointerCapture(pointerId);
    } catch {
      // Capture may already be gone (e.g. pointercancel) — ignore.
    }
    pointerId = -1;
    if (!dispatch || !e) {
      removeOverlay();
      return;
    }
    const rect = el.getBoundingClientRect();
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
    if (w < MIN_AREA_FRACTION && h < MIN_AREA_FRACTION) {
      // Treat as a click, not a drag. Don't dispatch; let normal click
      // handlers (if any) run via the platform.
      return;
    }
    send({ action, data: { x, y, w, h } });
  };

  const onPointerLeaveCancel = () => {
    // Fallback for the rare case where setPointerCapture failed: without
    // capture, pointermove + pointerup stop arriving once the pointer
    // leaves the host, freezing the overlay. Treating pointerleave as
    // a cancel keeps the overlay from getting stuck on screen.
    finalize(null, false);
  };

  const onPointerDown = (e: PointerEvent) => {
    // Only primary button (left mouse / single touch / pen tip). Modifier
    // keys passed through so the server-side handler can decide what to
    // do with them via subsequent renders.
    if (!e.isPrimary || e.button !== 0) return;
    // Re-entrancy guard: if a prior drag never finished (e.g. capture
    // failed silently, then pointer left the element with no pointerup
    // ever delivered), the WeakMap entry would still hold pointerId.
    // Cancel the prior drag — removing its overlay and listeners —
    // before starting a fresh one.
    if (pointerId !== -1) finalize(null, false);
    const parent = el.parentElement;
    if (!parent) return; // overlay needs a positioned container
    startClientX = e.clientX;
    startClientY = e.clientY;
    pointerId = e.pointerId;
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
    e.preventDefault();
  };

  const updateOverlay = (e: PointerEvent) => {
    if (!overlay) return;
    const parent = el.parentElement;
    if (!parent) return;
    const elRect = el.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    // Position the overlay relative to the parent's content box so it
    // tracks with `position: absolute` correctly.
    const left = Math.min(startClientX, e.clientX) - parentRect.left;
    const top = Math.min(startClientY, e.clientY) - parentRect.top;
    const width = Math.abs(e.clientX - startClientX);
    const height = Math.abs(e.clientY - startClientY);
    // Clamp to the host's rendered rect so a drag that runs off the
    // edge doesn't paint outside the image.
    const minLeft = elRect.left - parentRect.left;
    const minTop = elRect.top - parentRect.top;
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

  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointermove", onPointerMove);
  el.addEventListener("pointerup", onPointerUp);
  el.addEventListener("pointercancel", onPointerCancel);
  // lostpointercapture handles the rare case where the platform yanks
  // capture (e.g. another element calls setPointerCapture, OS gesture).
  el.addEventListener("lostpointercapture", onPointerCancel);

  const cleanup = () => {
    el.removeEventListener("pointerdown", onPointerDown);
    el.removeEventListener("pointermove", onPointerMove);
    el.removeEventListener("pointerup", onPointerUp);
    el.removeEventListener("pointercancel", onPointerCancel);
    el.removeEventListener("lostpointercapture", onPointerCancel);
    el.removeEventListener("pointerleave", onPointerLeaveCancel);
    finalize(null, false);
    areaSelectArmed.delete(el);
  };

  return { action, cleanup };
}

function clampRange(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n) || n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
