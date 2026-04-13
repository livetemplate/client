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

  // Throttles infinite-scroll dispatches: one in-flight load_more at a time.
  // Without this, rapid observer re-fires stack concurrent actions and the
  // server's per-response diffs compose into duplicate rows on the client.
  private loadMorePending = false;

  constructor(
    private readonly context: ObserverContext,
    private readonly logger: Logger
  ) {}

  setupInfiniteScrollObserver(): void {
    const wrapperElement = this.context.getWrapperElement();
    if (!wrapperElement) return;

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

  setupInfiniteScrollMutationObserver(): void {
    const wrapperElement = this.context.getWrapperElement();
    if (!wrapperElement) return;

    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
    }

    this.mutationObserver = new MutationObserver(() => {
      this.loadMorePending = false;
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
    this.observedSentinel = null;
    this.loadMorePending = false;
  }
}
