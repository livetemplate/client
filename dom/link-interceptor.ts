import type { Logger } from "../utils/logger";

export interface LinkInterceptorContext {
  getWrapperElement(): Element | null;
  handleNavigationResponse(html: string): void;
}

/**
 * Intercepts <a> clicks within the LiveTemplate wrapper for SPA navigation.
 * Same-origin links are fetched via fetch() and the wrapper content is replaced.
 * External links, target="_blank", download, and lvt-nav:no-intercept are skipped.
 *
 * Uses AbortController to cancel in-flight fetches when a new navigation
 * starts (rapid clicks, back/forward during fetch).
 */
export class LinkInterceptor {
  private popstateListener: (() => void) | null = null;
  private abortController: AbortController | null = null;

  constructor(
    private readonly context: LinkInterceptorContext,
    private readonly logger: Logger
  ) {}

  /**
   * Remove the click listener registered by setup() for a specific
   * wrapper ID. Call this before cross-handler navigation changes the
   * wrapper's data-lvt-id, to prevent orphaned listeners.
   */
  teardownForWrapper(wrapperId: string | null): void {
    if (!wrapperId) return;
    const listenerKey = `__lvt_link_intercept_${wrapperId}`;
    const existing = (document as any)[listenerKey];
    if (existing) {
      document.removeEventListener("click", existing);
      delete (document as any)[listenerKey];
    }
  }

  setup(wrapper: Element): void {
    const wrapperId = wrapper.getAttribute("data-lvt-id");
    const listenerKey = `__lvt_link_intercept_${wrapperId}`;
    const existing = (document as any)[listenerKey];
    if (existing) {
      document.removeEventListener("click", existing);
    }

    const listener = (e: Event) => {
      const target = (e.target as Element)?.closest("a[href]") as HTMLAnchorElement | null;
      if (!target) return;

      const currentWrapper = this.context.getWrapperElement();
      if (!currentWrapper || !currentWrapper.contains(target)) return;

      if (this.shouldSkip(target)) return;

      e.preventDefault();
      this.navigate(target.href);
    };

    document.addEventListener("click", listener);
    (document as any)[listenerKey] = listener;

    // Handle back/forward navigation
    if (!this.popstateListener) {
      this.popstateListener = () => {
        this.navigate(window.location.href, false);
      };
      window.addEventListener("popstate", this.popstateListener);
    }
  }

  private shouldSkip(link: HTMLAnchorElement): boolean {
    // External links
    if (link.origin !== window.location.origin) return true;
    // target="_blank" or other targets
    if (link.target && link.target !== "_self") return true;
    // Download links
    if (link.hasAttribute("download")) return true;
    // Opt-out attribute for link interception
    if (link.hasAttribute("lvt-nav:no-intercept")) return true;
    // Hash-only links (scroll anchors)
    if (link.pathname === window.location.pathname && link.hash) return true;
    // mailto/tel/javascript
    const protocol = link.protocol;
    if (protocol !== "http:" && protocol !== "https:") return true;

    return false;
  }

  private async navigate(href: string, pushState: boolean = true): Promise<void> {
    // Cancel any in-flight navigation fetch
    this.abortController?.abort();
    this.abortController = new AbortController();

    try {
      const response = await fetch(href, {
        credentials: "include",
        headers: { Accept: "text/html" },
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        window.location.href = href;
        return;
      }

      const html = await response.text();

      // Push state BEFORE handling response so that cross-handler
      // navigation reconnects the WebSocket to the correct URL.
      // connect() derives the WebSocket path from window.location.
      if (pushState) {
        window.history.pushState(null, "", href);
      }

      this.context.handleNavigationResponse(html);
    } catch (e: unknown) {
      // AbortError means a new navigation superseded this one — ignore
      if (e instanceof DOMException && e.name === "AbortError") return;
      window.location.href = href;
    }
  }
}
