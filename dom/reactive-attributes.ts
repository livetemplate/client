/**
 * Reactive Attributes - Declarative DOM actions triggered by LiveTemplate lifecycle events.
 *
 * Attribute Pattern: lvt-{action}-on:{event}="param"
 *
 * Events:
 *   - pending: Action started, waiting for server response
 *   - success: Action completed successfully
 *   - error: Action completed with validation errors
 *   - done: Action completed (regardless of success/error)
 *
 * Event Scope:
 *   - Global: lvt-reset-on:success (any action)
 *   - Action-specific: lvt-reset-on:create-todo:success (specific action only)
 *
 * Actions:
 *   - reset: Calls form.reset()
 *   - disable: Sets element.disabled = true
 *   - enable: Sets element.disabled = false
 *   - addClass: Adds CSS class(es)
 *   - removeClass: Removes CSS class(es)
 *   - toggleClass: Toggles CSS class(es)
 *   - setAttr: Sets an attribute (name:value format)
 *   - toggleAttr: Toggles a boolean attribute
 */

export type ReactiveAction =
  | "reset"
  | "disable"
  | "enable"
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

const REACTIVE_ACTIONS: ReactiveAction[] = [
  "reset",
  "disable",
  "enable",
  "addClass",
  "removeClass",
  "toggleClass",
  "setAttr",
  "toggleAttr",
];

// Lowercase versions for case-insensitive matching (HTML attributes are lowercased)
const ACTION_MAP: Record<string, ReactiveAction> = {
  reset: "reset",
  disable: "disable",
  enable: "enable",
  addclass: "addClass",
  removeclass: "removeClass",
  toggleclass: "toggleClass",
  setattr: "setAttr",
  toggleattr: "toggleAttr",
};

/**
 * Parse a reactive attribute name and value into a binding.
 *
 * Examples:
 *   parseReactiveAttribute("lvt-reset-on:success", "") => { action: "reset", lifecycle: "success" }
 *   parseReactiveAttribute("lvt-addClass-on:pending", "loading") => { action: "addClass", lifecycle: "pending", param: "loading" }
 *   parseReactiveAttribute("lvt-reset-on:create-todo:success", "") => { action: "reset", lifecycle: "success", actionName: "create-todo" }
 */
export function parseReactiveAttribute(
  attrName: string,
  attrValue: string
): ReactiveBinding | null {
  // Pattern: lvt-{action}-on:{actionName?}:{lifecycle}
  // The lifecycle must be at the end, action name is optional in the middle
  // Note: HTML attributes are lowercased by browsers, so we match case-insensitively
  const match = attrName.toLowerCase().match(/^lvt-(\w+)-on:(.+)$/);
  if (!match) return null;

  const actionKey = match[1];
  const action = ACTION_MAP[actionKey];
  if (!action) return null;

  const eventPart = match[2];

  // Check if the last segment is a lifecycle event
  // Format: "{actionName}:{lifecycle}" or just "{lifecycle}"
  const segments = eventPart.split(":");
  const lastSegment = segments[segments.length - 1] as LifecycleEvent;

  if (!LIFECYCLE_EVENTS.includes(lastSegment)) return null;

  const lifecycle = lastSegment;
  const actionName = segments.length > 1 ? segments.slice(0, -1).join(":") : undefined;

  return {
    action,
    lifecycle,
    actionName: actionName || undefined,
    param: attrValue || undefined,
  };
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

    case "disable":
      if ("disabled" in element) {
        (element as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled = true;
      }
      break;

    case "enable":
      if ("disabled" in element) {
        (element as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled = false;
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
 *
 * @param binding The reactive binding to check
 * @param lifecycle The lifecycle event that fired
 * @param actionName The action name that triggered the event (optional)
 */
export function matchesEvent(
  binding: ReactiveBinding,
  lifecycle: LifecycleEvent,
  actionName?: string
): boolean {
  // Lifecycle must match
  if (binding.lifecycle !== lifecycle) return false;

  // If binding has no actionName, it's global (matches any action)
  if (!binding.actionName) return true;

  // If binding has actionName, it must match the fired action
  return binding.actionName === actionName;
}

/**
 * Process all reactive attributes for a lifecycle event.
 *
 * Instead of building complex selectors, we iterate all elements with any lvt-*-on:* attribute
 * and check each one against the fired event.
 */
export function processReactiveAttributes(
  lifecycle: LifecycleEvent,
  actionName?: string
): void {
  // Find all elements that might have reactive attributes
  // This is a broad selector but avoids escaping issues with attribute names containing colons
  const allElements = document.querySelectorAll("*");

  allElements.forEach((element) => {
    // Check all attributes on this element for reactive bindings
    Array.from(element.attributes).forEach((attr) => {
      // Quick filter: only process lvt-*-on: attributes
      if (!attr.name.startsWith("lvt-") || !attr.name.includes("-on:")) {
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
 * This should be called once during client initialization.
 */
export function setupReactiveAttributeListeners(): void {
  LIFECYCLE_EVENTS.forEach((lifecycle) => {
    // Listen in capture phase to process before event bubbles
    document.addEventListener(
      `lvt:${lifecycle}`,
      (e: Event) => {
        const customEvent = e as CustomEvent;
        const actionName = customEvent.detail?.action;
        processReactiveAttributes(lifecycle, actionName);
      },
      true // capture phase
    );
  });
}
