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
  // Counts in-flight actions so concurrent server roundtrips don't hide
  // the bar prematurely: the bar stays visible as long as at least one
  // `lvt:pending` is outstanding. Without this counter, action B
  // completing first would clear the bar even though action A is still
  // in flight.
  private pendingCount = 0;
  private pendingHandler: ((ev: Event) => void) | null = null;
  private updatedHandler: ((ev: Event) => void) | null = null;
  // Current per-action debounce — tracked so a follow-up enable call
  // with a different value reconfigures cleanly instead of silently
  // dropping the new value.
  private currentDebounceMs: number | null = null;

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
    // Same value as already enabled → no-op (idempotent).
    // Different value → tear down and re-register cleanly. This
    // matters for callers that re-read the debounce attribute after
    // a config change; without it, the second call would silently
    // discard the new value.
    if (this.pendingHandler) {
      if (this.currentDebounceMs === debounceMs) return;
      this.disablePerActionIndicator();
    }
    this.pendingCount = 0;
    this.currentDebounceMs = debounceMs;

    this.pendingHandler = () => {
      this.pendingCount++;
      // Only arm a debounce timer on the 0→1 transition. Subsequent
      // concurrent actions don't reset the timer or re-show the bar —
      // the bar that is or will become visible already represents "at
      // least one action in flight".
      if (
        this.pendingCount === 1 &&
        this.actionTimer === null &&
        this.bar === null
      ) {
        this.actionTimer = setTimeout(() => {
          this.actionTimer = null;
          // Re-check pendingCount at fire time. In single-threaded JS
          // `updatedHandler` would have called `clearTimeout` before the
          // count could reach zero, so this guard is defensive: it
          // documents the invariant and protects against any future
          // reordering of teardown vs. show.
          if (this.pendingCount > 0) this.show();
        }, debounceMs);
      }
    };
    this.updatedHandler = () => {
      // Math.max guards against an `lvt:updated` arriving without a
      // matching `lvt:pending` (e.g. a server push, or an action whose
      // pending event was dispatched before the listener was attached).
      this.pendingCount = Math.max(0, this.pendingCount - 1);
      if (this.pendingCount === 0) {
        if (this.actionTimer !== null) {
          clearTimeout(this.actionTimer);
          this.actionTimer = null;
        }
        this.hide();
      }
    };
    document.addEventListener("lvt:pending", this.pendingHandler, true);
    document.addEventListener("lvt:updated", this.updatedHandler, true);
  }

  /**
   * Teardown for `enablePerActionIndicator`. Stops the listeners, cancels
   * any pending debounce timer, resets the counter, and hides the bar
   * if it's currently visible. Hiding is part of teardown so a caller
   * that reconfigures (different debounce → disable + re-enable) doesn't
   * leave the prior cycle's bar orphaned waiting for an `lvt:updated`
   * that no listener will receive.
   *
   * Production callers reach this path via two routes: an explicit
   * reconfigure inside `enablePerActionIndicator`, and the LiveTemplate
   * client's `disconnect()` teardown.
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
    this.pendingCount = 0;
    this.currentDebounceMs = null;
    this.hide();
  }
}
