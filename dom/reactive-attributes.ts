/**
 * Reactive Attributes - Declarative DOM actions triggered by LiveTemplate lifecycle events.
 *
 * Attribute Pattern: lvt-el:{method}:on:[{action}:]{state|interaction}="param"
 *
 * States (lifecycle):
 *   - pending: Action started, waiting for server response
 *   - success: Action completed successfully
 *   - error: Action completed with validation errors
 *   - done: Action completed (regardless of success/error)
 *
 * Interactions:
 *   - click-away: Click outside the element (handled by setupClickAwayDelegation)
 *
 * Trigger Scope:
 *   - Unscoped: lvt-el:reset:on:success (any action)
 *   - Action-scoped: lvt-el:reset:on:create-todo:success (specific action only)
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
    // Skip interaction triggers (click-away) — handled by click-away delegation
    if (eventPart === "click-away") return null;

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
  const allElements = document.querySelectorAll("*");

  allElements.forEach((element) => {
    Array.from(element.attributes).forEach((attr) => {
      // Quick filter: only process lvt-el:*:on:* attributes
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
