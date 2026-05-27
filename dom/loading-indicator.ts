/**
 * Handles showing and hiding the global LiveTemplate loading indicator.
 *
 * Two activation paths share the same physical bar:
 *
 *   1. Initial connect — `data-lvt-loading="true"` on the wrapper triggers
 *      `show()` in autoInit; `hide()` fires from the first server payload.
 *   2. Per-action wait — `data-lvt-loading-debounce-ms="<ms>"` on the wrapper
 *      enables `enablePerActionIndicator(ms)`, which arms a timer on
 *      `lvt:pending` (capture-phase) and hides on `lvt:updated`. Idempotent.
 */
export class LoadingIndicator {
  private bar: HTMLElement | null = null;
  private actionTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingHandler: ((ev: Event) => void) | null = null;
  private updatedHandler: ((ev: Event) => void) | null = null;

  show(): void {
    if (this.bar) return;

    const bar = document.createElement("div");
    bar.className = "lvt-loading-bar";
    bar.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: linear-gradient(90deg, #3b82f6 0%, #60a5fa 50%, #3b82f6 100%);
      background-size: 200% 100%;
      z-index: 9999;
      animation: lvt-loading-shimmer 1.5s ease-in-out infinite;
    `;

    if (!document.getElementById("lvt-loading-styles")) {
      const style = document.createElement("style");
      style.id = "lvt-loading-styles";
      style.textContent = `
        @keyframes lvt-loading-shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `;
      document.head.appendChild(style);
    }

    document.body.insertBefore(bar, document.body.firstChild);
    this.bar = bar;
  }

  hide(): void {
    if (!this.bar) return;

    if (this.bar.parentNode) {
      this.bar.parentNode.removeChild(this.bar);
    }
    this.bar = null;
  }

  /**
   * Show the loading bar after `debounceMs` of an action being in flight;
   * hide on the next `lvt:updated`. Capture-phase listeners on document
   * catch both events regardless of dispatch target. Safe to call more
   * than once — repeat calls are no-ops.
   */
  enablePerActionIndicator(debounceMs: number): void {
    if (this.pendingHandler) return;

    this.pendingHandler = () => {
      if (this.actionTimer !== null || this.bar !== null) return;
      this.actionTimer = setTimeout(() => {
        this.actionTimer = null;
        this.show();
      }, debounceMs);
    };
    this.updatedHandler = () => {
      if (this.actionTimer !== null) {
        clearTimeout(this.actionTimer);
        this.actionTimer = null;
      }
      this.hide();
    };
    document.addEventListener("lvt:pending", this.pendingHandler, true);
    document.addEventListener("lvt:updated", this.updatedHandler, true);
  }

  /**
   * Teardown for `enablePerActionIndicator`. Primarily for tests — production
   * callers keep the listeners for the lifetime of the page.
   */
  disablePerActionIndicator(): void {
    if (this.pendingHandler) {
      document.removeEventListener("lvt:pending", this.pendingHandler, true);
      this.pendingHandler = null;
    }
    if (this.updatedHandler) {
      document.removeEventListener("lvt:updated", this.updatedHandler, true);
      this.updatedHandler = null;
    }
    if (this.actionTimer !== null) {
      clearTimeout(this.actionTimer);
      this.actionTimer = null;
    }
  }
}
