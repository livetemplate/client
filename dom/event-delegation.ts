import { debounce, throttle } from "../utils/rate-limit";
import { checkLvtConfirm } from "../utils/confirm";
import type { Logger } from "../utils/logger";

export interface EventDelegationContext {
  getWrapperElement(): Element | null;
  getRateLimitedHandlers(): WeakMap<Element, Map<string, Function>>;
  parseValue(value: string): any;
  send(message: any): void;
  setActiveSubmission(
    form: HTMLFormElement | null,
    button: HTMLButtonElement | null,
    originalButtonText: string | null
  ): void;
  openModal(modalId: string): void;
  closeModal(modalId: string): void;
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

        if (eventType === "submit") {
          (window as any).__lvtSubmitListenerTriggered = true;
          (window as any).__lvtSubmitEventTarget = (
            e.target as Element
          )?.tagName;
        }

        this.logger.debug("Event listener triggered:", eventType, e.target);

        const target = e.target as Element;
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

        if (eventType === "submit") {
          (window as any).__lvtInWrapper = inWrapper;
          (window as any).__lvtWrapperElement =
            currentWrapper.getAttribute("data-lvt-id");
        }

        if (!inWrapper) return;

        const attrName = `lvt-${eventType}`;
        element = target;

        while (element && element !== currentWrapper.parentElement) {
          let action = element.getAttribute(attrName);
          let actionElement = element;

          // Check for lvt-persist on form submit (auto-persist to database)
          if (!action && eventType === "submit" && element instanceof HTMLFormElement) {
            const persistTable = element.getAttribute("lvt-persist");
            if (persistTable) {
              action = `persist:${persistTable}`;
              actionElement = element;
            }
          }

          if (!action && (eventType === "change" || eventType === "input")) {
            const formElement: HTMLFormElement | null = element.closest("form");
            if (formElement && formElement.hasAttribute("lvt-change")) {
              action = formElement.getAttribute("lvt-change");
              actionElement = formElement;
            }
          }

          if (action && actionElement) {
            if (eventType === "submit") {
              (window as any).__lvtActionFound = action;
              (window as any).__lvtActionElement = actionElement.tagName;
            }

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

              // Handle lvt-confirm for any action
              if (!checkLvtConfirm(targetElement as HTMLElement)) {
                this.logger.debug("Action cancelled by user:", action);
                return;
              }

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

                formData.forEach((value, key) => {
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
                this.logger.debug("Form data collected:", message.data);
              } else if (eventType === "change" || eventType === "input") {
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

              Array.from(targetElement.attributes).forEach((attr) => {
                if (attr.name.startsWith("lvt-data-")) {
                  const key = attr.name.replace("lvt-data-", "");
                  message.data[key] = this.context.parseValue(attr.value);
                }
              });

              Array.from(targetElement.attributes).forEach((attr) => {
                if (attr.name.startsWith("lvt-value-")) {
                  const key = attr.name.replace("lvt-value-", "");
                  message.data[key] = this.context.parseValue(attr.value);
                }
              });

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
                  submitButton.hasAttribute("lvt-disable-with")
                ) {
                  originalButtonText = submitButton.textContent;
                  submitButton.disabled = true;
                  submitButton.textContent =
                    submitButton.getAttribute("lvt-disable-with");
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

              this.context.send(message);
              this.logger.debug("send() called");
            };

            const throttleValue = actionElement.getAttribute("lvt-throttle");
            const debounceValue = actionElement.getAttribute("lvt-debounce");

            // Skip rate limiting for "search" event (clear button click) - it's a discrete action
            const shouldRateLimit = (throttleValue || debounceValue) && eventType !== "search";

            if (shouldRateLimit) {
              if (!rateLimitedHandlers.has(actionElement)) {
                rateLimitedHandlers.set(actionElement, new Map());
              }
              const handlerCache = rateLimitedHandlers.get(actionElement)!;
              const cacheKey = `${eventType}:${action}`;

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
              if (eventType === "submit") {
                (window as any).__lvtBeforeHandleAction = true;
              }
              handleAction();
              if (eventType === "submit") {
                (window as any).__lvtAfterHandleAction = true;
              }
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

        const attrName = `lvt-window-${eventType}`;
        const elements = currentWrapper.querySelectorAll(`[${attrName}]`);

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

          Array.from(element.attributes).forEach((attr) => {
            if (attr.name.startsWith("lvt-data-")) {
              const key = attr.name.replace("lvt-data-", "");
              message.data[key] = this.context.parseValue(attr.value);
            }
          });

          Array.from(element.attributes).forEach((attr) => {
            if (attr.name.startsWith("lvt-value-")) {
              const key = attr.name.replace("lvt-value-", "");
              message.data[key] = this.context.parseValue(attr.value);
            }
          });

          const throttleValue = element.getAttribute("lvt-throttle");
          const debounceValue = element.getAttribute("lvt-debounce");

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
      const elements = currentWrapper.querySelectorAll("[lvt-click-away]");

      elements.forEach((element) => {
        if (!element.contains(target)) {
          const action = element.getAttribute("lvt-click-away");
          if (!action) return;

          const message: any = { action, data: {} };

          Array.from(element.attributes).forEach((attr) => {
            if (attr.name.startsWith("lvt-data-")) {
              const key = attr.name.replace("lvt-data-", "");
              message.data[key] = this.context.parseValue(attr.value);
            }
          });

          Array.from(element.attributes).forEach((attr) => {
            if (attr.name.startsWith("lvt-value-")) {
              const key = attr.name.replace("lvt-value-", "");
              message.data[key] = this.context.parseValue(attr.value);
            }
          });

          this.context.send(message);
        }
      });
    };

    (document as any)[listenerKey] = listener;
    document.addEventListener("click", listener);
  }

  setupModalDelegation(): void {
    const wrapperElement = this.context.getWrapperElement();
    if (!wrapperElement) return;

    const wrapperId = wrapperElement.getAttribute("data-lvt-id");

    const openListenerKey = `__lvt_modal_open_${wrapperId}`;
    const existingOpenListener = (document as any)[openListenerKey];
    if (existingOpenListener) {
      document.removeEventListener("click", existingOpenListener);
    }

    const openListener = (e: Event) => {
      const currentWrapper = this.context.getWrapperElement();
      if (!currentWrapper) return;

      const target = (e.target as Element)?.closest("[lvt-modal-open]");
      if (!target || !currentWrapper.contains(target)) return;

      const modalId = target.getAttribute("lvt-modal-open");
      if (!modalId) return;

      e.preventDefault();
      this.context.openModal(modalId);
    };

    (document as any)[openListenerKey] = openListener;
    document.addEventListener("click", openListener);

    const closeListenerKey = `__lvt_modal_close_${wrapperId}`;
    const existingCloseListener = (document as any)[closeListenerKey];
    if (existingCloseListener) {
      document.removeEventListener("click", existingCloseListener);
    }

    // Close listener is intentionally NOT scoped to wrapper (unlike openListener).
    // Close buttons may be inside modals rendered in portals outside the wrapper.
    // Instead, we verify the target modal exists by ID.
    const closeListener = (e: Event) => {
      const target = (e.target as Element)?.closest("[lvt-modal-close]");
      if (!target) return;

      const modalId = target.getAttribute("lvt-modal-close");
      if (!modalId) return;

      // Verify the modal exists before attempting to close
      const modal = document.getElementById(modalId);
      if (!modal) return;

      e.preventDefault();
      this.context.closeModal(modalId);
    };

    (document as any)[closeListenerKey] = closeListener;
    document.addEventListener("click", closeListener);

    const backdropListenerKey = `__lvt_modal_backdrop_${wrapperId}`;
    const existingBackdropListener = (document as any)[backdropListenerKey];
    if (existingBackdropListener) {
      document.removeEventListener("click", existingBackdropListener);
    }

    // Helper to close modal, dispatching action if data-modal-close-action is set
    const closeModalWithAction = (modal: Element, modalId: string) => {
      const closeAction = modal.getAttribute("data-modal-close-action");
      if (closeAction) {
        this.context.send({ action: closeAction, data: {} });
      } else {
        this.context.closeModal(modalId);
      }
    };

    const backdropListener = (e: Event) => {
      const target = e.target as Element;
      // Only trigger if clicked directly on the backdrop element itself
      if (!target.hasAttribute("data-modal-backdrop")) return;

      const modalId = target.getAttribute("data-modal-id");
      if (!modalId) return;

      const modal = document.getElementById(modalId);
      if (!modal) return;

      closeModalWithAction(modal, modalId);
    };

    (document as any)[backdropListenerKey] = backdropListener;
    document.addEventListener("click", backdropListener);

    const escapeListenerKey = `__lvt_modal_escape_${wrapperId}`;
    const existingEscapeListener = (document as any)[escapeListenerKey];
    if (existingEscapeListener) {
      document.removeEventListener("keydown", existingEscapeListener);
    }

    const escapeListener = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const currentWrapper = this.context.getWrapperElement();
      if (!currentWrapper) return;

      const openModals = currentWrapper.querySelectorAll(
        '[role="dialog"]:not([hidden])'
      );
      if (openModals.length > 0) {
        const lastModal = openModals[openModals.length - 1];
        if (lastModal.id) {
          closeModalWithAction(lastModal, lastModal.id);
        }
      }
    };

    (document as any)[escapeListenerKey] = escapeListener;
    document.addEventListener("keydown", escapeListener);
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
