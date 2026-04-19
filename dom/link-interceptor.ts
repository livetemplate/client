import type { Logger } from "../utils/logger";
import { isHashLinkTarget, activateHashTarget } from "./hash-link";

export interface LinkInterceptorContext {
  getWrapperElement(): Element | null;
  handleNavigationResponse(html: string): void;
  // Send an in-band navigate message over the existing WebSocket.
  // Returns true if the message was sent, false if it was dropped
  // (e.g. WS not open). The caller uses this to decide whether to push
  // browser history state — only advancing the URL when the server will
  // actually receive the navigate eliminates the TOCTOU window where
  // the WS could close between canSendNavigate() and the actual send.
  sendNavigate(href: string): boolean;
  // Returns true when an in-band navigate message can be sent (i.e.
  // WebSocket mode is active and the socket is OPEN). In HTTP mode or
  // when the WS is not yet open, this is false and the same-pathname
  // fast path must fall through to a normal fetch.
  canSendNavigate(): boolean;
}

/**
 * Intercepts <a> clicks within the LiveTemplate wrapper for SPA navigation.
 *
 * - Same pathname (query-string change only) -> sends __navigate__ over WS;
 *   no fetch, no DOM replace, no reconnect.
 * - Different pathname (cross-handler or just different route) -> fetches
 *   new HTML and hands it to handleNavigationResponse, which decides
 *   between same-handler DOM replace and cross-handler reconnect.
 * - External links, target="_blank", download, and lvt-nav:no-intercept
 *   are skipped.
 *
 * Uses AbortController to cancel in-flight fetches when a new navigation
 * starts (rapid clicks, back/forward during fetch).
 */
export class LinkInterceptor {
  private popstateListener: (() => void) | null = null;
  private abortController: AbortController | null = null;
  // Tracks the URL that was last successfully navigated to (or the initial
  // page URL). Updated after each in-band __navigate__ push and after each
  // fetch-based navigation. The popstate handler uses this to compare the
  // target URL against the URL we were actually at *before* the browser
  // changed window.location, because by the time popstate fires, the browser
  // has already moved window.location to the target — making a naive
  // window.location comparison always look like a same-URL no-op.
  private currentHref: string = window.location.href;

  constructor(
    private readonly context: LinkInterceptorContext,
    private readonly logger: Logger
  ) {}

  /**
   * Remove the click listener registered by setup() for a specific
   * wrapper ID. Call this before cross-handler navigation changes the
   * wrapper's data-lvt-id, to prevent orphaned listeners.
   *
   * Also aborts any in-flight navigate() fetch so it cannot call
   * handleNavigationResponse after teardown and trigger a duplicate
   * or out-of-date navigation.
   */
  teardownForWrapper(wrapperId: string | null): void {
    // Abort any in-flight fetch — whether or not a wrapper ID is passed.
    // The caller may be tearing down before a cross-handler transition,
    // and we don't want a pending fetch to land post-teardown.
    this.abortController?.abort();
    this.abortController = null;

    if (!wrapperId) return;
    const listenerKey = `__lvt_link_intercept_${wrapperId}`;
    const existing = (document as any)[listenerKey];
    if (existing) {
      // Explicit capture flag (false) for consistency with
      // EventDelegator.teardownForWrapper — defaults match but
      // explicit is clearer.
      document.removeEventListener("click", existing, false);
      delete (document as any)[listenerKey];
    }
  }

  setup(wrapper: Element): void {
    // Refresh currentHref so the popstate handler compares against the URL
    // that is actually showing when this setup runs, not a stale value from
    // a previous navigation or from construction time (which may predate the
    // first history.replaceState in tests and cross-handler nav re-setups).
    this.currentHref = window.location.href;

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

      if (target.pathname === window.location.pathname && target.search === window.location.search && target.hash) {
        const hashId = target.hash.slice(1);
        if (hashId && isHashLinkTarget(hashId)) {
          e.preventDefault();
          activateHashTarget(hashId);
        }
        return;
      }

      e.preventDefault();
      this.navigate(target.href);
    };

    document.addEventListener("click", listener);
    (document as any)[listenerKey] = listener;

    // Handle back/forward navigation
    if (!this.popstateListener) {
      this.popstateListener = () => {
        // Capture the URL we were at *before* the browser moved to the new
        // history entry. This lets navigate() compare pathname+search against
        // the previous URL rather than window.location (which already reflects
        // the target after popstate fires).
        const prevHref = this.currentHref;
        this.currentHref = window.location.href;
        this.navigate(window.location.href, false, prevHref);
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
    // mailto/tel/javascript
    const protocol = link.protocol;
    if (protocol !== "http:" && protocol !== "https:") return true;

    return false;
  }

  // prevHref is the URL the client was at *before* this navigation.
  // For link clicks (pushState=true) it defaults to window.location.href,
  // which is correct because pushState hasn't run yet. For popstate
  // (pushState=false) the popstate listener supplies the saved currentHref
  // so the same-pathname comparison reflects the real previous entry, not
  // window.location (which the browser already updated to the target).
  private async navigate(
    href: string,
    pushState: boolean = true,
    prevHref: string = window.location.href
  ): Promise<void> {
    const targetURL = new URL(href, window.location.origin);
    const refURL = new URL(prevHref, window.location.origin);
    const samePath =
      targetURL.origin === refURL.origin &&
      targetURL.pathname === refURL.pathname;

    if (samePath) {
      const sameSearch = targetURL.search === refURL.search;
      if (sameSearch) {
        // Hash-only change or exact same URL — the browser handles scroll
        // to the anchor; no server round-trip is needed. This also correctly
        // handles popstate for hash-only back/forward because the popstate
        // listener passes prevHref (the previous entry), so refURL reflects
        // where we came from rather than the already-updated window.location.
        //
        // Still abort any in-flight cross-path fetch: if a fetch was in
        // progress when the user clicked a hash anchor, we don't want it
        // to resolve and call handleNavigationResponse unexpectedly.
        this.abortController?.abort();
        this.abortController = null;
        return;
      }

      // __navigate__ fast path: same pathname, different search, WS mode.
      // Only for explicit forward navigation (pushState=true / link clicks).
      // For popstate (pushState=false) the search difference is real (it
      // compares against the previous entry via prevHref), but back/forward
      // must restore prior page state via a full fetch, not a WS message
      // that only forwards query data to Mount.
      if (pushState && this.context.canSendNavigate()) {
        // Abort any in-flight fetch even on the fast path: a user could
        // click a cross-path link (starting a fetch) and quickly click a
        // same-pathname link. Without aborting, the earlier fetch can
        // still resolve and call handleNavigationResponse, racing with the
        // in-band __navigate__ update.
        this.abortController?.abort();
        this.abortController = null;
        // sendNavigate returns true if the WS message was actually sent.
        // Push history state ONLY on success to keep window.location
        // consistent with what the server received.
        // If sent === false (defensive path — normally unreachable since
        // canSendNavigate() already checked readyState), fall through to
        // the normal fetch so the navigation isn't silently dropped.
        const sent = this.context.sendNavigate(href);
        if (sent) {
          window.history.pushState(null, "", href);
          this.currentHref = href;
          return;
        }
        // sendNavigate returned false — fall through to fetch as recovery.
      }
      // HTTP mode, WS not OPEN, sendNavigate returned false, or popstate:
      // fall through to normal fetch. pushState is handled downstream.
    }

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

      this.currentHref = href;
      this.context.handleNavigationResponse(html);
    } catch (e: unknown) {
      // AbortError means a new navigation superseded this one — ignore
      if (e instanceof DOMException && e.name === "AbortError") return;
      window.location.href = href;
    }
  }
}
