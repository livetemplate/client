import { debounce, throttle } from "../utils/rate-limit";
import { lvtSelector } from "../utils/lvt-selector";
import { executeAction, processElementInteraction, isDOMEventTrigger, type ReactiveAction } from "./reactive-attributes";
import type { Logger } from "../utils/logger";

// Methods supported by click-away, derived from ReactiveAction values
const CLICK_AWAY_METHOD_MAP: Record<string, ReactiveAction> = {
  reset: "reset",
  addclass: "addClass",
  removeclass: "removeClass",
  toggleclass: "toggleClass",
  setattr: "setAttr",
  toggleattr: "toggleAttr",
};
const CLICK_AWAY_METHODS = Object.keys(CLICK_AWAY_METHOD_MAP);

export interface EventDelegationContext {
  getWrapperElement(): Element | null;
  getRateLimitedHandlers(): WeakMap<Element, Map<string, Function>>;
  parseValue(value: string): any;
  send(message: any): void;
  sendHTTPMultipart(form: HTMLFormElement, action: string): void;
  setActiveSubmission(
    form: HTMLFormElement | null,
    button: HTMLButtonElement | null,
    originalButtonText: string | null
  ): void;
  getWebSocketReadyState(): number | undefined;
  triggerPendingUploads(uploadName: string): void;
}

/**
 * Handles all DOM event delegation concerns for LiveTemplateClient.
 */
export class EventDelegator {
  constructor(
    private readonly context: EventDelegationContext,
    private readonly logger: Logger
  ) {}

  private extractButtonData(button: HTMLButtonElement | HTMLInputElement, data: Record<string, any>): void {
    if (button.value) {
      data.value = this.context.parseValue(button.value);
    }
    Array.from(button.attributes).forEach((attr) => {
      if (attr.name.startsWith("data-") && attr.name !== "data-key") {
        const key = attr.name.slice(5);
        data[key] = this.context.parseValue(attr.value);
      }
    });
  }

  setupEventDelegation(): void {
    const wrapperElement = this.context.getWrapperElement();
    if (!wrapperElement) return;

    const eventTypes = [
      "click",
      "submit",
      "change",
      "input",
      "search", // Fired when clearing input type="search" via X button
      "keydown",
      "keyup",
      "focus",
      "blur",
      "mouseenter",
      "mouseleave",
    ];
    const wrapperId = wrapperElement.getAttribute("data-lvt-id");
    const rateLimitedHandlers = this.context.getRateLimitedHandlers();

    eventTypes.forEach((eventType) => {
      const listenerKey = `__lvt_delegated_${eventType}_${wrapperId}`;
      const existingListener = (document as any)[listenerKey];
      if (existingListener) {
        document.removeEventListener(eventType, existingListener, false);
      }

      const listener = (e: Event) => {
        const currentWrapper = this.context.getWrapperElement();
        if (!currentWrapper) return;

        const target = e.target as Element;

        this.logger.debug("Event listener triggered:", eventType, e.target);

        if (!target) return;

        let element: Element | null = target;
        let inWrapper = false;

        while (element) {
          if (element === currentWrapper) {
            inWrapper = true;
            break;
          }
          element = element.parentElement;
        }

        if (!inWrapper) return;

        const attrName = `lvt-on:${eventType}`;
        element = target;

        while (element && element !== currentWrapper.parentElement) {
          let action = element.getAttribute(attrName);
          let actionElement = element;
          let isOrphanButton = false;

          // Check for lvt-persist on form submit (auto-persist to database)
          if (!action && eventType === "submit" && element instanceof HTMLFormElement) {
            const persistTable = element.getAttribute("lvt-persist");
            if (persistTable) {
              action = `persist:${persistTable}`;
              actionElement = element;
            }
          }

          // Orphan button detection (Tier 1: formless standalone buttons).
          // A <button name="action"> outside any form triggers the named action directly.
          // Resolution order for click events:
          //   1. lvt-on:click attribute (Tier 2 — already checked above)
          //   2. Orphan button name (Tier 1 — checked here)
          if (!action && eventType === "click") {
            const btn = element instanceof HTMLButtonElement ? element : null;
            if (
              btn &&
              btn.name &&
              !btn.disabled &&
              btn.type !== "reset" &&
              btn.form === null &&
              !btn.hasAttribute("commandfor")
            ) {
              action = btn.name;
              actionElement = btn;
              isOrphanButton = true;
            }
          }

          // Auto-intercept forms (progressive complexity).
          // Action resolution order:
          //   1. lvt-form:action attribute (explicit routing)
          //   2. submitter.name (button name = action)
          //   3. form.name (form name = action)
          //   4. "submit" (server defaults to Submit())
          //
          // Note: lvt-action hidden field is a server-side progressive
          // enhancement fallback (no-JS POST). The client does not read it;
          // the server extracts it from form data directly.
          if (!action && eventType === "submit" && element instanceof HTMLFormElement) {
            if (!element.hasAttribute("lvt-form:no-intercept")) {
              // Check for explicit routing attribute first.
              // Empty string ("") falls through to submitter/form name resolution.
              const explicitAction = element.getAttribute("lvt-form:action");
              const submitter = (e as SubmitEvent).submitter;
              if (explicitAction) {
                action = explicitAction;
              } else {
                if (submitter instanceof HTMLButtonElement && submitter.name) {
                  action = submitter.name;
                } else if (element.getAttribute("name")) {
                  action = element.getAttribute("name")!;
                } else {
                  action = "submit";
                }
              }
              actionElement = element;

              if (submitter) {
                (element as any).__lvtSubmitter = submitter;
              }

              // Dialog support: forms with method="dialog" inside <dialog>
              // close the dialog AND route the action to the server.
              const dialog = element.closest("dialog");
              if (dialog && element.getAttribute("method")?.toLowerCase() === "dialog") {
                (element as any).__lvtCloseDialog = dialog;
              }
            }
          }

          if (action != null && actionElement) {
            if (eventType === "submit") {
              e.preventDefault();
            }

            if (
              (eventType === "keydown" || eventType === "keyup") &&
              actionElement.hasAttribute("lvt-key")
            ) {
              const keyFilter = actionElement.getAttribute("lvt-key");
              const keyboardEvent = e as KeyboardEvent;
              if (keyFilter && keyboardEvent.key !== keyFilter) {
                element = element.parentElement;
                continue;
              }
            }

            const targetElement = actionElement;

            const handleAction = () => {
              this.logger.debug("handleAction called", {
                action,
                eventType,
                targetElement,
              });

              const message: any = { action, data: {} };

              if (targetElement instanceof HTMLFormElement) {
                this.logger.debug("Processing form element");
                const formData = new FormData(targetElement);

                const checkboxes = Array.from(
                  targetElement.querySelectorAll('input[type="checkbox"][name]')
                ) as HTMLInputElement[];
                const checkboxNames = new Set(checkboxes.map((cb) => cb.name));

                checkboxNames.forEach((name) => {
                  message.data[name] = false;
                });

                // Get password field names to skip parseValue for them
                const passwordFields = new Set(
                  Array.from(
                    targetElement.querySelectorAll('input[type="password"][name]')
                  ).map((el) => (el as HTMLInputElement).name)
                );

                // Exclude the submitter button's name from form data.
                // The submitter's name is used as the action routing key in the
                // button-name path — including it in data would be redundant.
                // When lvt-form:action overrides routing, the button name is still
                // excluded to avoid noisy payloads (the button is a UI control,
                // not domain data). Button value and data-* attrs are collected below.
                // "action" is NOT excluded — it's a normal data field.
                const submitterForData = (targetElement as any).__lvtSubmitter as HTMLButtonElement | undefined;
                const actionFieldName = submitterForData?.name;

                formData.forEach((value, key) => {
                  if (value instanceof File) return; // Skip file entries — handled by sendHTTPMultipart
                  if (actionFieldName && key === actionFieldName) return;
                  if (checkboxNames.has(key)) {
                    message.data[key] = true;
                    this.logger.debug("Converted checkbox", key, "to true");
                  } else if (passwordFields.has(key)) {
                    // Never parse password values - always keep as string
                    message.data[key] = value as string;
                  } else {
                    message.data[key] = this.context.parseValue(
                      value as string
                    );
                  }
                });

                // Collect data from the submitter button:
                // - button value → data.value (e.g., <button name="delete" value="{{.ID}}">)
                // - data-* attributes → data keys
                const submitter2 = (targetElement as any).__lvtSubmitter as HTMLButtonElement | undefined;
                if (submitter2) {
                  this.extractButtonData(submitter2, message.data);
                  delete (targetElement as any).__lvtSubmitter;
                }

                this.logger.debug("Form data collected:", message.data);
              } else if (eventType === "change" || eventType === "input" || eventType === "search") {
                if (targetElement instanceof HTMLInputElement) {
                  const key = targetElement.name || "value";
                  message.data[key] = this.context.parseValue(
                    targetElement.value
                  );
                } else if (targetElement instanceof HTMLSelectElement) {
                  const key = targetElement.name || "value";
                  message.data[key] = this.context.parseValue(
                    targetElement.value
                  );
                } else if (targetElement instanceof HTMLTextAreaElement) {
                  const key = targetElement.name || "value";
                  message.data[key] = this.context.parseValue(
                    targetElement.value
                  );
                }
              }

              if (isOrphanButton) {
                this.extractButtonData(actionElement as HTMLButtonElement, message.data);
              }

              // Extract standard data-* attributes from the action element.
              // Exclude data-key (list reconciliation) and data-lvt-id (internal framework ID)
              // since these are LiveTemplate internals, not user-provided action data.
              if (!(targetElement instanceof HTMLFormElement) && !isOrphanButton) {
                Array.from(actionElement.attributes).forEach((attr) => {
                  if (attr.name.startsWith("data-") && attr.name !== "data-key" && attr.name !== "data-lvt-id") {
                    const key = attr.name.slice(5);
                    message.data[key] = this.context.parseValue(attr.value);
                  }
                });
              }

              if (
                eventType === "submit" &&
                targetElement instanceof HTMLFormElement
              ) {
                const submitEvent = e as SubmitEvent;
                const submitButton =
                  submitEvent.submitter as HTMLButtonElement | null;
                let originalButtonText: string | null = null;

                if (
                  submitButton &&
                  submitButton.hasAttribute("lvt-form:disable-with")
                ) {
                  originalButtonText = submitButton.textContent;
                  submitButton.disabled = true;
                  submitButton.textContent =
                    submitButton.getAttribute("lvt-form:disable-with");
                  this.logger.debug("Disabled submit button");
                }

                this.context.setActiveSubmission(
                  targetElement,
                  submitButton || null,
                  originalButtonText
                );

                // Trigger pending uploads for any file inputs in the form
                const fileInputs = targetElement.querySelectorAll<HTMLInputElement>(
                  'input[type="file"][lvt-upload]'
                );
                fileInputs.forEach((input) => {
                  const uploadName = input.getAttribute("lvt-upload");
                  if (uploadName) {
                    this.logger.debug("Triggering pending uploads for:", uploadName);
                    this.context.triggerPendingUploads(uploadName);
                  }
                });

                targetElement.dispatchEvent(
                  new CustomEvent("lvt:pending", { detail: message })
                );
                this.logger.debug("Emitted lvt:pending event");
              }

              this.logger.debug("About to send message:", message);
              this.logger.debug(
                "WebSocket state:",
                this.context.getWebSocketReadyState()
              );

              // Tier 1 file uploads: forms with file inputs (without lvt-upload)
              // are submitted via HTTP fetch with FormData instead of WebSocket.
              // Binary files can't be sent efficiently over WebSocket (base64 overhead).
              if (targetElement instanceof HTMLFormElement) {
                const tier1FileInputs = targetElement.querySelectorAll<HTMLInputElement>(
                  'input[type="file"]:not([lvt-upload])'
                );
                const hasFiles = Array.from(tier1FileInputs).some(
                  (input) => input.files && input.files.length > 0
                );
                if (hasFiles) {
                  this.logger.debug("Tier 1 file upload detected, using HTTP fetch");
                  this.context.sendHTTPMultipart(targetElement, action);
                  return;
                }
              }

              this.context.send(message);
              this.logger.debug("send() called");

              // Close dialog if this was a method="dialog" form inside <dialog>
              if (targetElement instanceof HTMLFormElement) {
                const dialogToClose = (targetElement as any).__lvtCloseDialog as HTMLDialogElement | undefined;
                if (dialogToClose) {
                  dialogToClose.close();
                  delete (targetElement as any).__lvtCloseDialog;
                }
              }
            };

            const throttleValue = actionElement.getAttribute("lvt-mod:throttle");
            const debounceValue = actionElement.getAttribute("lvt-mod:debounce");

            // Skip rate limiting for "search" event (clear button click) - it's a discrete action
            const shouldRateLimit = (throttleValue || debounceValue) && eventType !== "search";

            if (shouldRateLimit) {
              if (!rateLimitedHandlers.has(actionElement)) {
                rateLimitedHandlers.set(actionElement, new Map());
              }
              const handlerCache = rateLimitedHandlers.get(actionElement)!;
              const cacheKey = `${eventType}:${action}`;

              // Store callback reference on the element itself to avoid type issues with the Map
              // This allows us to update the callback each event while reusing the debounced timer
              const callbackRefKey = `__lvt_callback_${cacheKey}`;
              const elementWithCallback = actionElement as HTMLElement & { [key: string]: { current: () => void } };
              if (!elementWithCallback[callbackRefKey]) {
                elementWithCallback[callbackRefKey] = { current: handleAction };
              }
              // Always update to the latest handleAction (with fresh closure capturing current values)
              elementWithCallback[callbackRefKey].current = handleAction;

              let rateLimitedHandler = handlerCache.get(cacheKey);
              if (!rateLimitedHandler) {
                // Create rate-limited function that calls the CURRENT callback via reference
                // This way, when the debounce timer fires, it uses the latest captured values
                const callLatest = () => elementWithCallback[callbackRefKey].current();
                if (throttleValue) {
                  const limit = parseInt(throttleValue, 10);
                  rateLimitedHandler = throttle(callLatest, limit);
                } else if (debounceValue) {
                  const wait = parseInt(debounceValue, 10);
                  rateLimitedHandler = debounce(callLatest, wait);
                }
                if (rateLimitedHandler) {
                  handlerCache.set(cacheKey, rateLimitedHandler);
                }
              }

              if (rateLimitedHandler) {
                rateLimitedHandler();
              }
            } else {
              handleAction();
            }

            return;
          }
          element = element.parentElement;
        }
      };

      (document as any)[listenerKey] = listener;
      document.addEventListener(eventType, listener, false);
      this.logger.debug(
        "Registered event listener:",
        eventType,
        "with key:",
        listenerKey
      );
    });
  }

  setupWindowEventDelegation(): void {
    const wrapperElement = this.context.getWrapperElement();
    if (!wrapperElement) return;

    const windowEvents = [
      "keydown",
      "keyup",
      "scroll",
      "resize",
      "focus",
      "blur",
    ];
    const wrapperId = wrapperElement.getAttribute("data-lvt-id");
    const rateLimitedHandlers = this.context.getRateLimitedHandlers();

    windowEvents.forEach((eventType) => {
      const listenerKey = `__lvt_window_${eventType}_${wrapperId}`;
      const existingListener = (window as any)[listenerKey];
      if (existingListener) {
        window.removeEventListener(eventType, existingListener);
      }

      const listener = (e: Event) => {
        const currentWrapper = this.context.getWrapperElement();
        if (!currentWrapper) return;

        const attrName = `lvt-on:window:${eventType}`;
        const elements = currentWrapper.querySelectorAll(lvtSelector(attrName));

        elements.forEach((element) => {
          const action = element.getAttribute(attrName);
          if (!action) return;

          if (
            (eventType === "keydown" || eventType === "keyup") &&
            element.hasAttribute("lvt-key")
          ) {
            const keyFilter = element.getAttribute("lvt-key");
            const keyboardEvent = e as KeyboardEvent;
            if (keyFilter && keyboardEvent.key !== keyFilter) {
              return;
            }
          }

          const message: any = { action, data: {} };

          // Extract standard data-* attributes from element
          Array.from(element.attributes).forEach((attr) => {
            if (attr.name.startsWith("data-") && attr.name !== "data-key" && attr.name !== "data-lvt-id") {
              const key = attr.name.slice(5);
              message.data[key] = this.context.parseValue(attr.value);
            }
          });

          const throttleValue = element.getAttribute("lvt-mod:throttle");
          const debounceValue = element.getAttribute("lvt-mod:debounce");

          const handleAction = () => this.context.send(message);

          if (throttleValue || debounceValue) {
            if (!rateLimitedHandlers.has(element)) {
              rateLimitedHandlers.set(element, new Map());
            }
            const handlerCache = rateLimitedHandlers.get(element)!;
            const cacheKey = `window-${eventType}:${action}`;

            let rateLimitedHandler = handlerCache.get(cacheKey);
            if (!rateLimitedHandler) {
              if (throttleValue) {
                const limit = parseInt(throttleValue, 10);
                rateLimitedHandler = throttle(handleAction, limit);
              } else if (debounceValue) {
                const wait = parseInt(debounceValue, 10);
                rateLimitedHandler = debounce(handleAction, wait);
              }
              if (rateLimitedHandler) {
                handlerCache.set(cacheKey, rateLimitedHandler);
              }
            }

            if (rateLimitedHandler) {
              rateLimitedHandler();
            }
          } else {
            handleAction();
          }
        });
      };

      (window as any)[listenerKey] = listener;
      window.addEventListener(eventType, listener);
    });
  }

  /**
   * Sets up click-away detection for lvt-el:*:on:click-away attributes.
   * Instead of routing to a server action, click-away triggers client-side
   * DOM manipulation via executeAction from reactive-attributes.
   */
  setupClickAwayDelegation(): void {
    const wrapperElement = this.context.getWrapperElement();
    if (!wrapperElement) return;

    const wrapperId = wrapperElement.getAttribute("data-lvt-id");
    const listenerKey = `__lvt_click_away_${wrapperId}`;
    const existingListener = (document as any)[listenerKey];
    if (existingListener) {
      document.removeEventListener("click", existingListener);
    }

    const listener = (e: Event) => {
      const currentWrapper = this.context.getWrapperElement();
      if (!currentWrapper) return;

      const target = e.target as Element;

      const clickAwaySelector = CLICK_AWAY_METHODS
        .map(m => lvtSelector(`lvt-el:${m}:on:click-away`))
        .join(", ");
      const clickAwayElements = currentWrapper.querySelectorAll(clickAwaySelector);
      clickAwayElements.forEach((element) => {
        if (element.contains(target)) return; // Click was inside, not away

        Array.from(element.attributes).forEach((attr) => {
          if (!attr.name.includes(":on:click-away")) return;
          const match = attr.name.match(/^lvt-el:(\w+):on:click-away$/);
          if (!match) return;
          const method = CLICK_AWAY_METHOD_MAP[match[1].toLowerCase()];
          if (!method) return;
          executeAction(element, method, attr.value);
        });
      });
    };

    (document as any)[listenerKey] = listener;
    document.addEventListener("click", listener);
  }

  /**
   * Sets up event listeners for lvt-el:*:on:{event} attributes where {event}
   * is a native DOM event (not a lifecycle state or synthetic trigger).
   *
   * Scans scanRoot (or the full wrapper if omitted) for elements with these
   * attributes. Attaches direct listeners for non-bubbling events (mouseenter,
   * mouseleave) and delegated listeners on the wrapper for bubbling events
   * (click, focusin, focusout, etc.).
   *
   * Bubbling delegation uses closest-match semantics: if both a child and parent
   * have the same trigger, only the child's action fires. This differs from native
   * event bubbling and prevents unintended double-firing in nested structures.
   *
   * Called during connect and after each DOM update to handle new elements.
   *
   * @param scanRoot - Subtree to scan for new attributes. Defaults to full wrapper.
   *                   Pass the updated element after a DOM patch to avoid a full rescan.
   */
  setupDOMEventTriggerDelegation(scanRoot?: Element): void {
    const wrapperElement = this.context.getWrapperElement();
    if (!wrapperElement) return;

    const wrapperId = wrapperElement.getAttribute("data-lvt-id");
    if (!wrapperId) return;
    // Non-bubbling events need direct attachment
    const NON_BUBBLING = new Set(["mouseenter", "mouseleave", "focus", "blur"]);
    // Track which bubbling events we've already delegated at wrapper level
    const delegatedKey = `__lvt_el_delegated_${wrapperId}`;
    const delegated: Set<string> = (wrapperElement as any)[delegatedKey] || new Set();

    // Scan the provided subtree (or full wrapper) for lvt-el:*:on:{event} attributes
    const root = scanRoot || wrapperElement;
    root.querySelectorAll("*").forEach(el => {
      const triggers = new Set<string>();
      for (const attr of el.attributes) {
        if (!attr.name.startsWith("lvt-el:")) continue;
        const match = attr.name.match(/^lvt-el:\w+:on:([a-z-]+)$/i);
        if (!match) continue;
        const trigger = match[1].toLowerCase();
        if (!isDOMEventTrigger(trigger)) continue;
        triggers.add(trigger);
      }

      for (const trigger of triggers) {
        if (NON_BUBBLING.has(trigger)) {
          // Direct attachment for non-bubbling events
          const key = `__lvt_el_${trigger}`;
          if ((el as any)[key]) continue; // already attached
          const listener = () => processElementInteraction(el, trigger);
          el.addEventListener(trigger, listener);
          (el as any)[key] = listener;
        } else if (!delegated.has(trigger)) {
          // Delegated listener on wrapper for bubbling events.
          // Walks from target to wrapper, processing only the closest matching element.
          const triggerPattern = new RegExp(`^lvt-el:\\w+:on:${trigger}$`, "i");
          const handler = (e: Event) => {
            let target = e.target as Element | null;
            while (target && target !== wrapperElement) {
              const hasMatch = Array.from(target.attributes).some(
                a => triggerPattern.test(a.name)
              );
              if (hasMatch) {
                processElementInteraction(target, trigger);
                return; // Stop at closest match
              }
              target = target.parentElement;
            }
            // Also check wrapper itself
            if (target === wrapperElement) {
              processElementInteraction(wrapperElement, trigger);
            }
          };
          wrapperElement.addEventListener(trigger, handler);
          delegated.add(trigger);
          // Store for teardown
          const listenersKey = `__lvt_el_listeners_${wrapperId}`;
          const listeners: Array<{ event: string; handler: EventListener }> =
            (wrapperElement as any)[listenersKey] || [];
          listeners.push({ event: trigger, handler });
          (wrapperElement as any)[listenersKey] = listeners;
        }
      }
    });

    (wrapperElement as any)[delegatedKey] = delegated;
  }

  /**
   * Remove delegated DOM event trigger listeners added by setupDOMEventTriggerDelegation.
   * Call on disconnect to prevent stale listeners firing on a disconnected component.
   */
  teardownDOMEventTriggerDelegation(): void {
    const wrapperElement = this.context.getWrapperElement();
    if (!wrapperElement) return;

    const wrapperId = wrapperElement.getAttribute("data-lvt-id");
    if (!wrapperId) return;

    const listenersKey = `__lvt_el_listeners_${wrapperId}`;
    const listeners: Array<{ event: string; handler: EventListener }> | undefined =
      (wrapperElement as any)[listenersKey];
    if (listeners) {
      listeners.forEach(({ event, handler }) => {
        wrapperElement.removeEventListener(event, handler);
      });
      delete (wrapperElement as any)[listenersKey];
    }

    const delegatedKey = `__lvt_el_delegated_${wrapperId}`;
    delete (wrapperElement as any)[delegatedKey];
  }

  /**
   * Sets up focus trapping for elements with lvt-focus-trap attribute.
   * Focus is trapped within the element, cycling through focusable elements
   * when Tab/Shift+Tab is pressed.
   */
  setupFocusTrapDelegation(): void {
    const wrapperElement = this.context.getWrapperElement();
    if (!wrapperElement) return;

    const wrapperId = wrapperElement.getAttribute("data-lvt-id");
    const listenerKey = `__lvt_focus_trap_${wrapperId}`;
    const existingListener = (document as any)[listenerKey];
    if (existingListener) {
      document.removeEventListener("keydown", existingListener);
    }

    const getFocusableElements = (container: Element): HTMLElement[] => {
      const selector = [
        'a[href]:not([disabled])',
        'button:not([disabled])',
        'textarea:not([disabled])',
        'input:not([disabled]):not([type="hidden"])',
        'select:not([disabled])',
        '[tabindex]:not([tabindex="-1"]):not([disabled])',
        '[contenteditable="true"]'
      ].join(', ');

      return Array.from(container.querySelectorAll(selector)).filter(
        (el) => {
          const htmlEl = el as HTMLElement;
          // Check if element is visible
          const style = window.getComputedStyle(htmlEl);
          const isNotDisplayNone = style.display !== 'none';
          const isNotVisibilityHidden = style.visibility !== 'hidden';
          // offsetParent can be null in JSDOM or for fixed/absolute positioned elements
          const hasLayoutContext = htmlEl.offsetParent !== null ||
                                   style.position === 'fixed' ||
                                   style.position === 'absolute' ||
                                   // In test environments, offsetParent may always be null
                                   (typeof process !== 'undefined' && (process as any).env?.NODE_ENV === 'test');
          return isNotDisplayNone && isNotVisibilityHidden && hasLayoutContext;
        }
      ) as HTMLElement[];
    };

    const listener = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;

      const currentWrapper = this.context.getWrapperElement();
      if (!currentWrapper) return;

      // Find the active focus trap container (innermost one containing the focused element)
      const focusTrapElements = currentWrapper.querySelectorAll("[lvt-focus-trap]");
      let activeTrap: Element | null = null;

      focusTrapElements.forEach((trap) => {
        if (trap.contains(document.activeElement)) {
          // Check if this is the innermost trap containing the focused element
          if (!activeTrap || trap.contains(activeTrap)) {
            activeTrap = trap;
          }
        }
      });

      // If there's a visible focus trap that doesn't contain the active element,
      // and is visible, trap focus there (for newly opened modals/dropdowns)
      if (!activeTrap) {
        focusTrapElements.forEach((trap) => {
          const htmlTrap = trap as HTMLElement;
          const style = window.getComputedStyle(htmlTrap);
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            activeTrap = trap;
          }
        });
      }

      if (!activeTrap) return;

      const focusableElements = getFocusableElements(activeTrap);
      if (focusableElements.length === 0) return;

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      if (e.shiftKey) {
        // Shift+Tab: moving backwards
        if (document.activeElement === firstElement) {
          e.preventDefault();
          lastElement.focus();
        }
      } else {
        // Tab: moving forwards
        if (document.activeElement === lastElement) {
          e.preventDefault();
          firstElement.focus();
        }
      }
    };

    (document as any)[listenerKey] = listener;
    document.addEventListener("keydown", listener);
    this.logger.debug("Focus trap delegation set up");
  }

  /**
   * Sets up autofocus for elements with lvt-autofocus attribute.
   * Automatically focuses the first element with lvt-autofocus when it becomes visible.
   * Uses MutationObserver to detect when elements are added or become visible.
   */
  setupAutofocusDelegation(): void {
    const wrapperElement = this.context.getWrapperElement();
    if (!wrapperElement) return;

    const wrapperId = wrapperElement.getAttribute("data-lvt-id");
    const observerKey = `__lvt_autofocus_observer_${wrapperId}`;

    // Disconnect existing observer if any
    const existingObserver = (wrapperElement as any)[observerKey];
    if (existingObserver) {
      existingObserver.disconnect();
    }

    const processAutofocus = () => {
      const currentWrapper = this.context.getWrapperElement();
      if (!currentWrapper) return;

      // Find all elements with lvt-autofocus that are visible
      const autofocusElements = currentWrapper.querySelectorAll("[lvt-autofocus]");

      autofocusElements.forEach((element) => {
        const htmlElement = element as HTMLElement;
        const style = window.getComputedStyle(htmlElement);

        // Check if element is visible and hasn't been focused yet in this visibility state
        // Note: offsetParent can be null in JSDOM or for fixed/absolute positioned elements,
        // so we only use it as a secondary check when it's available
        const isNotDisplayNone = style.display !== 'none';
        const isNotVisibilityHidden = style.visibility !== 'hidden';
        const hasLayoutContext = htmlElement.offsetParent !== null ||
                                 style.position === 'fixed' ||
                                 style.position === 'absolute' ||
                                 htmlElement.tagName === 'BODY' ||
                                 // In test environments, offsetParent may always be null
                                 (typeof process !== 'undefined' && (process as any).env?.NODE_ENV === 'test');
        const isVisible = isNotDisplayNone && isNotVisibilityHidden && hasLayoutContext;

        const wasFocused = htmlElement.getAttribute("data-lvt-autofocused") === "true";

        if (isVisible && !wasFocused) {
          // Mark as focused to prevent re-focusing on every mutation
          htmlElement.setAttribute("data-lvt-autofocused", "true");

          // Use requestAnimationFrame to ensure DOM is ready
          requestAnimationFrame(() => {
            htmlElement.focus();
            this.logger.debug("Autofocused element:", htmlElement.tagName, htmlElement.id || htmlElement.getAttribute("name"));
          });
        } else if (!isVisible && wasFocused) {
          // Reset the flag when element becomes hidden so it can be refocused when shown again
          htmlElement.removeAttribute("data-lvt-autofocused");
        }
      });
    };

    // Process autofocus immediately for any existing elements
    processAutofocus();

    // Set up MutationObserver to watch for new autofocus elements or visibility changes
    const observer = new MutationObserver((mutations) => {
      let shouldProcess = false;

      mutations.forEach((mutation) => {
        // Check for added nodes
        if (mutation.type === "childList" && mutation.addedNodes.length > 0) {
          mutation.addedNodes.forEach((node) => {
            if (node instanceof Element) {
              if (node.hasAttribute("lvt-autofocus") || node.querySelector("[lvt-autofocus]")) {
                shouldProcess = true;
              }
            }
          });
        }

        // Check for attribute changes that might affect visibility
        // We intentionally check "class" changes to handle CSS-based visibility
        // (e.g., Tailwind's "hidden" class, Bootstrap's "d-none", etc.)
        // This may cause some extra processing but ensures visibility changes
        // via class toggles are detected.
        if (mutation.type === "attributes") {
          const target = mutation.target as Element;
          if (target.hasAttribute("lvt-autofocus") ||
              mutation.attributeName === "hidden" ||
              mutation.attributeName === "style" ||
              mutation.attributeName === "class") {
            shouldProcess = true;
          }
        }
      });

      if (shouldProcess) {
        processAutofocus();
      }
    });

    observer.observe(wrapperElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden", "style", "class", "lvt-autofocus"]
    });

    (wrapperElement as any)[observerKey] = observer;
    this.logger.debug("Autofocus delegation set up");
  }

}
