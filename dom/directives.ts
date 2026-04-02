/**
 * Apply scroll directives on elements with lvt-scroll attributes.
 */
export function handleScrollDirectives(rootElement: Element): void {
  const scrollElements = rootElement.querySelectorAll("[lvt-scroll]");

  scrollElements.forEach((element) => {
    const htmlElement = element as HTMLElement;
    const mode = htmlElement.getAttribute("lvt-scroll");
    const behavior =
      (htmlElement.getAttribute("lvt-scroll-behavior") as ScrollBehavior) ||
      "auto";
    const threshold = parseInt(
      htmlElement.getAttribute("lvt-scroll-threshold") || "100",
      10
    );

    if (!mode) return;

    switch (mode) {
      case "bottom":
        htmlElement.scrollTo({
          top: htmlElement.scrollHeight,
          behavior,
        });
        break;

      case "bottom-sticky": {
        const isNearBottom =
          htmlElement.scrollHeight -
            htmlElement.scrollTop -
            htmlElement.clientHeight <=
          threshold;
        if (isNearBottom) {
          htmlElement.scrollTo({
            top: htmlElement.scrollHeight,
            behavior,
          });
        }
        break;
      }

      case "top":
        htmlElement.scrollTo({
          top: 0,
          behavior,
        });
        break;

      case "preserve":
        break;

      default:
        console.warn(`Unknown lvt-scroll mode: ${mode}`);
    }
  });
}

/**
 * Apply highlight directives to elements with lvt-highlight attributes.
 */
export function handleHighlightDirectives(rootElement: Element): void {
  const highlightElements = rootElement.querySelectorAll("[lvt-highlight]");

  highlightElements.forEach((element) => {
    const mode = element.getAttribute("lvt-highlight");
    const duration = parseInt(
      element.getAttribute("lvt-highlight-duration") || "500",
      10
    );
    const color = element.getAttribute("lvt-highlight-color") || "#ffc107";

    if (!mode) return;

    const htmlElement = element as HTMLElement;
    const originalBackground = htmlElement.style.backgroundColor;
    const originalTransition = htmlElement.style.transition;

    htmlElement.style.transition = `background-color ${duration}ms ease-out`;
    htmlElement.style.backgroundColor = color;

    setTimeout(() => {
      htmlElement.style.backgroundColor = originalBackground;

      setTimeout(() => {
        htmlElement.style.transition = originalTransition;
      }, duration);
    }, 50);
  });
}

/**
 * Apply animation directives to elements with lvt-animate attributes.
 */
export function handleAnimateDirectives(rootElement: Element): void {
  const animateElements = rootElement.querySelectorAll("[lvt-animate]");

  animateElements.forEach((element) => {
    const animation = element.getAttribute("lvt-animate");
    const duration = parseInt(
      element.getAttribute("lvt-animate-duration") || "300",
      10
    );

    if (!animation) return;

    const htmlElement = element as HTMLElement;

    htmlElement.style.setProperty("--lvt-animate-duration", `${duration}ms`);

    switch (animation) {
      case "fade":
        htmlElement.style.animation = `lvt-fade-in var(--lvt-animate-duration) ease-out`;
        break;

      case "slide":
        htmlElement.style.animation = `lvt-slide-in var(--lvt-animate-duration) ease-out`;
        break;

      case "scale":
        htmlElement.style.animation = `lvt-scale-in var(--lvt-animate-duration) ease-out`;
        break;

      default:
        console.warn(`Unknown lvt-animate mode: ${animation}`);
    }

    htmlElement.addEventListener(
      "animationend",
      () => {
        htmlElement.style.animation = "";
      },
      { once: true }
    );
  });

  if (!document.getElementById("lvt-animate-styles")) {
    const style = document.createElement("style");
    style.id = "lvt-animate-styles";
    style.textContent = `
      @keyframes lvt-fade-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @keyframes lvt-slide-in {
        from {
          opacity: 0;
          transform: translateY(-10px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
      @keyframes lvt-scale-in {
        from {
          opacity: 0;
          transform: scale(0.95);
        }
        to {
          opacity: 1;
          transform: scale(1);
        }
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
      if (!messages.length) return;

      const stack = getOrCreateToastStack();
      messages.forEach((msg) => {
        const el = createToastElement(msg);
        stack.appendChild(el);
        if (msg.dismissMS > 0) {
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

function getOrCreateToastStack(): HTMLElement {
  let stack = document.querySelector(
    "[data-lvt-toast-stack]"
  ) as HTMLElement | null;
  if (!stack) {
    stack = document.createElement("div");
    stack.setAttribute("data-lvt-toast-stack", "");
    stack.setAttribute("aria-live", "polite");
    document.body.appendChild(stack);
  }
  return stack;
}

function createToastElement(msg: ToastMessage): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("role", "alert");
  el.setAttribute("data-lvt-toast-item", msg.id);

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

