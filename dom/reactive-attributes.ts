/**
 * Reactive Attributes - Declarative DOM actions triggered by lifecycle events or interactions.
 *
 * Attribute Pattern: lvt-el:{method}:on:{trigger}="param"
 *
 * Trigger types:
 *
 * 1. Lifecycle states (server action request-response cycle):
 *    - pending, success, error, done
 *    - Supports action scoping: lvt-el:reset:on:create-todo:success
 *
 * 2. Native DOM events (client-side, no server round-trip):
 *    - Any browser event: click, focusin, focusout, mouseenter, mouseleave, keydown, etc.
 *    - No action scoping (fires on the element's own event)
 *
 * 3. Synthetic interactions (client-side):
 *    - click-away: Click outside the element
 *    - No action scoping
 *
 * Methods:
 *   - reset: Calls form.reset()
 *   - addClass: Adds CSS class(es)
 *   - removeClass: Removes CSS class(es)
 *   - toggleClass: Toggles CSS class(es)
 *   - setAttr: Sets an attribute (name:value format)
 *   - toggleAttr: Toggles a boolean attribute
 */

export type ReactiveAction =
  | "reset"
  | "addClass"
  | "removeClass"
  | "toggleClass"
  | "setAttr"
  | "toggleAttr";

export type LifecycleEvent = "pending" | "success" | "error" | "done";

export interface ReactiveBinding {
  action: ReactiveAction;
  lifecycle: LifecycleEvent;
  actionName?: string;
  param?: string;
}

const LIFECYCLE_EVENTS: LifecycleEvent[] = ["pending", "success", "error", "done"];
const LIFECYCLE_SET = new Set<string>(LIFECYCLE_EVENTS);

/**
 * Reserved trigger keywords that are NOT native DOM events.
 * click-away is a synthetic interaction handled by setupClickAwayDelegation.
 * Everything else that's not a lifecycle state is treated as a native DOM event.
 */
export const SYNTHETIC_TRIGGERS = new Set(["click-away"]);

// Lowercase method names → canonical ReactiveAction
const METHOD_MAP: Record<string, ReactiveAction> = {
  reset: "reset",
  addclass: "addClass",
  removeclass: "removeClass",
  toggleclass: "toggleClass",
  setattr: "setAttr",
  toggleattr: "toggleAttr",
};

/**
 * Parse a reactive attribute name and value into a binding.
 *
 * Supported pattern: lvt-el:{method}:on:[{action}:]{state}
 *
 * Examples:
 *   parseReactiveAttribute("lvt-el:reset:on:success", "") => { action: "reset", lifecycle: "success" }
 *   parseReactiveAttribute("lvt-el:addclass:on:pending", "loading") => { action: "addClass", lifecycle: "pending", param: "loading" }
 *   parseReactiveAttribute("lvt-el:reset:on:create-todo:success", "") => { action: "reset", lifecycle: "success", actionName: "create-todo" }
 */
export function parseReactiveAttribute(
  attrName: string,
  attrValue: string
): ReactiveBinding | null {
  const lower = attrName.toLowerCase();

  // New pattern: lvt-el:{method}:on:[{action}:]{state}
  const newMatch = lower.match(/^lvt-el:(\w+):on:(.+)$/);
  if (newMatch) {
    const methodKey = newMatch[1];
    const action = METHOD_MAP[methodKey];
    if (!action) return null;

    const eventPart = newMatch[2];
    // Skip synthetic triggers (click-away) — handled by setupClickAwayDelegation
    if (SYNTHETIC_TRIGGERS.has(eventPart)) return null;
    // Skip native DOM event triggers — handled by setupDOMEventTriggerDelegation
    if (!LIFECYCLE_SET.has(eventPart) && !eventPart.includes(":")) return null;

    const segments = eventPart.split(":");
    const lastSegment = segments[segments.length - 1];
    if (!LIFECYCLE_SET.has(lastSegment)) return null;

    const lifecycle = lastSegment as LifecycleEvent;
    const actionName = segments.length > 1 ? segments.slice(0, -1).join(":") : undefined;

    return {
      action,
      lifecycle,
      actionName: actionName || undefined,
      param: attrValue || undefined,
    };
  }

  return null;
}

/**
 * Execute a reactive action on an element.
 */
export function executeAction(
  element: Element,
  action: ReactiveAction,
  param?: string
): void {
  switch (action) {
    case "reset":
      if (element instanceof HTMLFormElement) {
        element.reset();
      }
      break;

    case "addClass":
      if (param) {
        const classes = param.split(/\s+/).filter(Boolean);
        element.classList.add(...classes);
      }
      break;

    case "removeClass":
      if (param) {
        const classes = param.split(/\s+/).filter(Boolean);
        element.classList.remove(...classes);
      }
      break;

    case "toggleClass":
      if (param) {
        const classes = param.split(/\s+/).filter(Boolean);
        classes.forEach((c) => element.classList.toggle(c));
      }
      break;

    case "setAttr":
      if (param) {
        const colonIndex = param.indexOf(":");
        if (colonIndex > 0) {
          const name = param.substring(0, colonIndex);
          const value = param.substring(colonIndex + 1);
          element.setAttribute(name, value);
        }
      }
      break;

    case "toggleAttr":
      if (param) {
        element.toggleAttribute(param);
      }
      break;
  }
}

/**
 * Check if an event matches a binding.
 */
export function matchesEvent(
  binding: ReactiveBinding,
  lifecycle: LifecycleEvent,
  actionName?: string
): boolean {
  if (binding.lifecycle !== lifecycle) return false;
  if (!binding.actionName) return true;
  return binding.actionName === actionName;
}

/**
 * Process all reactive attributes for a lifecycle event.
 */
export function processReactiveAttributes(
  lifecycle: LifecycleEvent,
  actionName?: string
): void {
  // Target only elements with lvt-el: attributes instead of scanning all DOM elements.
  // CSS doesn't support attribute-name-starts-with, so we build selectors from known
  // method prefixes. This covers both unscoped (lvt-el:reset:on:success) and
  // action-scoped (lvt-el:reset:on:create-todo:success) patterns.
  const methodKeys = Object.keys(METHOD_MAP);
  const selectorParts: string[] = [];

  // Escape CSS-special characters in actionName for use in attribute selectors
  const escapedAction = actionName
    ? actionName.replace(/([^\w-])/g, "\\$1")
    : undefined;

  for (const m of methodKeys) {
    selectorParts.push(`[lvt-el\\:${m}\\:on\\:${lifecycle}]`);
    if (escapedAction) {
      selectorParts.push(`[lvt-el\\:${m}\\:on\\:${escapedAction}\\:${lifecycle}]`);
    }
  }
  const selector = selectorParts.join(", ");

  let candidates: NodeListOf<Element>;
  try {
    candidates = document.querySelectorAll(selector);
  } catch {
    // If selector is still invalid despite escaping, scan targeted elements only
    // by matching unscoped patterns (without actionName)
    const fallbackParts = methodKeys.map(m => `[lvt-el\\:${m}\\:on\\:${lifecycle}]`);
    try {
      candidates = document.querySelectorAll(fallbackParts.join(", "));
    } catch {
      return; // Cannot construct any valid selector
    }
  }

  candidates.forEach((element) => {
    Array.from(element.attributes).forEach((attr) => {
      if (!attr.name.startsWith("lvt-el:") || !attr.name.includes(":on:")) {
        return;
      }

      const binding = parseReactiveAttribute(attr.name, attr.value);
      if (binding && matchesEvent(binding, lifecycle, actionName)) {
        executeAction(element, binding.action, binding.param);
      }
    });
  });
}

/**
 * Process all lvt-el:*:on:{trigger} attributes on an element for a given trigger.
 */
export function processElementInteraction(element: Element, trigger: string): void {
  for (const attr of element.attributes) {
    const match = attr.name.match(/^lvt-el:(\w+):on:([a-z-]+)$/i);
    if (!match) continue;
    if (match[2].toLowerCase() !== trigger) continue;

    const methodKey = match[1].toLowerCase();
    const action = METHOD_MAP[methodKey];
    if (!action) continue;

    executeAction(element, action, attr.value);
  }
}

/**
 * Checks if a trigger name is a native DOM event (not lifecycle or synthetic).
 */
export function isDOMEventTrigger(trigger: string): boolean {
  return !LIFECYCLE_SET.has(trigger) && !SYNTHETIC_TRIGGERS.has(trigger);
}

/**
 * Set up document-level event listeners for reactive attributes.
 */
export function setupReactiveAttributeListeners(): void {
  LIFECYCLE_EVENTS.forEach((lifecycle) => {
    document.addEventListener(
      `lvt:${lifecycle}`,
      (e: Event) => {
        const customEvent = e as CustomEvent;
        const actionName = customEvent.detail?.action;
        processReactiveAttributes(lifecycle, actionName);
      },
      true
    );
  });
}
