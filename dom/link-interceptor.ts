import type { Logger } from "../utils/logger";

export interface LinkInterceptorContext {
  getWrapperElement(): Element | null;
  handleNavigationResponse(html: string): void;
}

/**
 * Intercepts <a> clicks within the LiveTemplate wrapper for SPA navigation.
 * Same-origin links are fetched via fetch() and the wrapper content is replaced.
 * External links, target="_blank", download, and lvt-no-intercept are skipped.
 */
export class LinkInterceptor {
  private popstateListener: (() => void) | null = null;

  constructor(
    private readonly context: LinkInterceptorContext,
    private readonly logger: Logger
  ) {}

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
    // Opt-out
    if (link.hasAttribute("lvt-no-intercept")) return true;
    // Hash-only links (scroll anchors)
    if (link.pathname === window.location.pathname && link.hash) return true;
    // mailto/tel/javascript
    const protocol = link.protocol;
    if (protocol !== "http:" && protocol !== "https:") return true;

    return false;
  }

  private async navigate(href: string, pushState: boolean = true): Promise<void> {
    try {
      const response = await fetch(href, {
        credentials: "include",
        headers: { Accept: "text/html" },
      });

      if (!response.ok) {
        window.location.href = href;
        return;
      }

      const html = await response.text();
      this.context.handleNavigationResponse(html);

      if (pushState) {
        window.history.pushState(null, "", href);
      }
    } catch {
      window.location.href = href;
    }
  }
}
