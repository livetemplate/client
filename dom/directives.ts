import { isDOMEventTrigger, SYNTHETIC_TRIGGERS } from "./reactive-attributes";

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

/**
 * Test-only: reset the module-level animatedElements WeakSet. Required
 * for tests that reuse the same DOM nodes across cases — without this,
 * an element animated in case 1 would be silently skipped in case 2.
 * Production code should never call this.
 *
 * The double-underscore prefix and the `@internal` tag signal that
 * this is not part of the public API. TypeScript's API Extractor and
 * similar tools exclude `@internal` exports from generated d.ts files.
 *
 * @internal
 */
export function __resetAnimatedElementsForTesting(): void {
  animatedElements = new WeakSet<Element>();
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
        applyFxEffect(el as HTMLElement, effect, currentValue);
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
          (htmlElement as any).__lvtHighlighting = false;
          return;
        }
        htmlElement.style.backgroundColor = originalBackground;
        setTimeout(() => {
          if (htmlElement.isConnected) htmlElement.style.transition = originalTransition;
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
          const isNearBottom = htmlElement.scrollHeight - htmlElement.scrollTop - htmlElement.clientHeight <= threshold;
          if (isNearBottom) htmlElement.scrollTo({ top: htmlElement.scrollHeight, behavior });
          break;
        }
        case "top":
          htmlElement.scrollTo({ top: 0, behavior });
          break;
        case "preserve":
          break;
        default:
          console.warn(`Unknown lvt-fx:scroll mode: ${mode}`);
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

