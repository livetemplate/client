import type { Logger } from "../utils/logger";

export interface ObserverContext {
  getWrapperElement(): Element | null;
  send(message: any): void;
}

/**
 * Manages LiveTemplate observers such as infinite scroll and DOM mutations.
 */
export class ObserverManager {
  private infiniteScrollObserver: IntersectionObserver | null = null;
  private mutationObserver: MutationObserver | null = null;
  private observedSentinel: Element | null = null;
  private updatedListener: ((e: Event) => void) | null = null;
  private updatedListenerWrapper: Element | null = null;

  // Throttles infinite-scroll dispatches: one in-flight load_more at a time.
  // Without this, rapid observer re-fires stack concurrent actions and the
  // server's per-response diffs compose into duplicate rows on the client.
  //
  // Cleared precisely when the server confirms the load_more response has
  // been applied (via the `lvt:updated` event with `action === "load_more"`),
  // NOT on every DOM mutation — an unrelated mutation (e.g. a flash message
  // toggling, a highlight flashing) between the dispatch and the response
  // would otherwise clear the flag early and allow a concurrent send.
  private loadMorePending = false;

  constructor(
    private readonly context: ObserverContext,
    private readonly logger: Logger
  ) {}

  setupInfiniteScrollObserver(): void {
    const wrapperElement = this.context.getWrapperElement();
    if (!wrapperElement) return;

    // Attach the lvt:updated listener once per wrapper. The event fires
    // after every tree update carrying the dispatched action's name in
    // its detail; we use action === "load_more" as the precise signal
    // that the throttle can be lifted.
    this.ensureUpdatedListener(wrapperElement);

    const sentinel = document.getElementById("scroll-sentinel");
    if (!sentinel) {
      // Sentinel removed (HasMore flipped false): release the old observer.
      if (this.infiniteScrollObserver) {
        this.infiniteScrollObserver.disconnect();
        this.infiniteScrollObserver = null;
        this.observedSentinel = null;
      }
      return;
    }

    // Reuse the existing observer when the sentinel node is the same —
    // avoids allocating a fresh IntersectionObserver per DOM mutation.
    if (this.infiniteScrollObserver && this.observedSentinel === sentinel) {
      return;
    }

    if (this.infiniteScrollObserver) {
      this.infiniteScrollObserver.disconnect();
    }

    this.infiniteScrollObserver = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting) return;
        if (this.loadMorePending) {
          this.logger.debug("Sentinel visible but load_more already pending, skipping");
          return;
        }
        this.loadMorePending = true;
        this.logger.debug("Sentinel visible, sending load_more action");
        this.context.send({ action: "load_more" });
      },
      {
        rootMargin: "200px",
      }
    );

    this.infiniteScrollObserver.observe(sentinel);
    this.observedSentinel = sentinel;
    this.logger.debug("Observer set up successfully");
  }

  private ensureUpdatedListener(wrapper: Element): void {
    if (this.updatedListener && this.updatedListenerWrapper === wrapper) return;
    // Detach any listener from the previous wrapper (e.g. after cross-
    // handler navigation swaps the wrapper element).
    if (this.updatedListener && this.updatedListenerWrapper) {
      this.updatedListenerWrapper.removeEventListener("lvt:updated", this.updatedListener);
    }
    this.updatedListener = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.action !== "load_more") return;
      this.loadMorePending = false;
      // Force a fresh IntersectionObserver so its immediate callback fires
      // with the post-mutation intersection state — lets the auto-advance
      // cascade continue if the sentinel is still visible after the new
      // rows are appended.
      this.observedSentinel = null;
      this.setupInfiniteScrollObserver();
    };
    wrapper.addEventListener("lvt:updated", this.updatedListener);
    this.updatedListenerWrapper = wrapper;
  }

  setupInfiniteScrollMutationObserver(): void {
    const wrapperElement = this.context.getWrapperElement();
    if (!wrapperElement) return;

    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
    }

    // The mutation observer catches structural changes that replace the
    // sentinel DOM node (e.g. morphdom recreating it on a page-level
    // restructure). setupInfiniteScrollObserver's identity check makes
    // the common case — same sentinel, new mutation — a cheap no-op.
    this.mutationObserver = new MutationObserver(() => {
      this.setupInfiniteScrollObserver();
    });

    this.mutationObserver.observe(wrapperElement, {
      childList: true,
      subtree: true,
    });

    this.logger.debug("MutationObserver set up successfully");
  }

  teardown(): void {
    if (this.infiniteScrollObserver) {
      this.infiniteScrollObserver.disconnect();
      this.infiniteScrollObserver = null;
    }
    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
      this.mutationObserver = null;
    }
    if (this.updatedListener && this.updatedListenerWrapper) {
      this.updatedListenerWrapper.removeEventListener("lvt:updated", this.updatedListener);
    }
    this.updatedListener = null;
    this.updatedListenerWrapper = null;
    this.observedSentinel = null;
    this.loadMorePending = false;
  }
}
