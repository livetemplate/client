/**
 * Tests for in-band navigate message (same-handler SPA navigation).
 *
 * Same-pathname link clicks must bypass fetch() entirely and send a
 * {action: "__navigate__", data: <query params>} message over the
 * existing WebSocket. The server's event loop special-cases this
 * action name to re-run Mount with the new query data without
 * tearing down the connection — the in-band equivalent of Phoenix
 * LiveView's live_patch / handle_params.
 *
 * The regression these tests guard against is the devbox-dash bug
 * where clicking between same-handler variants (/claude?s=A vs
 * /claude?s=B) would swap DOM but leave the server's per-connection
 * state pinned to the original query params, so the next server-driven
 * refresh clobbered the DOM with stale content.
 */

import { LinkInterceptor, LinkInterceptorContext } from "../dom/link-interceptor";
import type { Logger } from "../utils/logger";

// Minimal logger stub — LinkInterceptor uses it only for debug/error logging.
const silentLogger: Logger = {
  isDebugEnabled: () => false,
  isInfoEnabled: () => false,
  isWarnEnabled: () => true,
  isErrorEnabled: () => true,
  child: () => silentLogger,
  setLevel: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  trace: () => {},
} as unknown as Logger;

describe("LinkInterceptor same-pathname navigate bypass", () => {
  let wrapper: HTMLElement;
  let sendNavigateSpy: jest.Mock<void, [string]>;
  let handleNavigationResponseSpy: jest.Mock<void, [string]>;
  let fetchMock: jest.SpyInstance;
  let interceptor: LinkInterceptor;

  beforeEach(() => {
    document.body.replaceChildren();
    wrapper = document.createElement("div");
    wrapper.setAttribute("data-lvt-id", "nav-test-wrapper");
    document.body.appendChild(wrapper);

    sendNavigateSpy = jest.fn();
    handleNavigationResponseSpy = jest.fn();
    // jsdom doesn't ship a global fetch; define a no-op stub so jest.spyOn
    // has something to wrap. jest.restoreAllMocks() in afterEach then cleans
    // up the spy automatically, even if beforeEach throws after this point.
    if (typeof (globalThis as any).fetch !== "function") {
      (globalThis as any).fetch = () => {};
    }
    fetchMock = jest
      .spyOn(globalThis as any, "fetch")
      .mockImplementation(() =>
        Promise.resolve(new Response("<html></html>", { status: 200 }))
      );

    const ctx: LinkInterceptorContext = {
      getWrapperElement: () => wrapper,
      handleNavigationResponse: handleNavigationResponseSpy,
      sendNavigate: sendNavigateSpy,
      canSendNavigate: () => true,
    };
    interceptor = new LinkInterceptor(ctx, silentLogger);
    interceptor.setup(wrapper);

    // Pin the current location so test navigations have something to
    // compare their pathname against. jsdom defaults to about:blank,
    // which has no useful pathname.
    history.replaceState(null, "", "/claude?s=initial");
  });

  afterEach(() => {
    jest.restoreAllMocks();
    // Tear down any listeners the interceptor added to document.
    interceptor.teardownForWrapper(wrapper.getAttribute("data-lvt-id"));
  });

  it("same-pathname link click sends navigate message, no fetch", async () => {
    // Build a link whose href shares the current pathname but has
    // a different query string.
    const link = document.createElement("a");
    link.href = "/claude?s=new-session";
    link.textContent = "switch";
    wrapper.appendChild(link);

    // Simulate a real user click.
    link.click();

    // Give the async navigate path a microtask to run.
    await Promise.resolve();

    expect(sendNavigateSpy).toHaveBeenCalledTimes(1);
    expect(sendNavigateSpy.mock.calls[0][0]).toContain("s=new-session");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(handleNavigationResponseSpy).not.toHaveBeenCalled();

    // History state should have been updated so a subsequent
    // reload picks up the new URL.
    expect(window.location.search).toBe("?s=new-session");
  });

  it("different-pathname link click goes through fetch, not navigate", async () => {
    const link = document.createElement("a");
    link.href = "/other-page";
    link.textContent = "other";
    wrapper.appendChild(link);

    link.click();

    // Give the sync portion of LinkInterceptor.navigate a microtask.
    // We're only asserting that fetch() was invoked (the key branch
    // point) and sendNavigate was NOT — not that the post-fetch chain
    // completed.
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sendNavigateSpy).not.toHaveBeenCalled();
  });

  it("external-origin link click is not intercepted at all", async () => {
    const link = document.createElement("a");
    link.href = "https://example.com/claude?s=foo";
    link.textContent = "external";
    wrapper.appendChild(link);

    link.click();
    await Promise.resolve();

    expect(sendNavigateSpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(handleNavigationResponseSpy).not.toHaveBeenCalled();
  });

  it("same-pathname click aborts any in-flight cross-path fetch", async () => {
    // Regression: if a cross-path fetch is in flight and the user then
    // clicks a same-pathname link, the earlier fetch must be aborted so
    // it cannot later call handleNavigationResponse and race with the
    // in-band __navigate__ update.

    // First, initiate a cross-path fetch that never resolves until aborted.
    let capturedSignal: AbortSignal | null = null;
    fetchMock.mockImplementation((_url: string, opts: RequestInit) => {
      capturedSignal = opts.signal as AbortSignal;
      // Never resolve — the test controls when this settles via the signal.
      return new Promise((_resolve, _reject) => {
        opts.signal?.addEventListener("abort", () => {
          _reject(new DOMException("AbortError", "AbortError"));
        });
      });
    });

    const crossPathLink = document.createElement("a");
    crossPathLink.href = "/other-page?x=1";
    wrapper.appendChild(crossPathLink);
    crossPathLink.click();
    await Promise.resolve();

    // Cross-path click should have started a fetch and captured the signal.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capturedSignal).not.toBeNull();
    expect((capturedSignal as unknown as AbortSignal).aborted).toBe(false);

    // Now click a same-pathname link — this must abort the in-flight fetch.
    const samePathLink = document.createElement("a");
    samePathLink.href = "/claude?s=fast-nav";
    wrapper.appendChild(samePathLink);
    samePathLink.click();
    await Promise.resolve();

    expect(sendNavigateSpy).toHaveBeenCalledTimes(1);
    expect((capturedSignal as unknown as AbortSignal).aborted).toBe(true);
  });

  it("same-pathname with no query string still sends navigate (empty data)", async () => {
    // User clicks a link that drops all query params ("back to list").
    const link = document.createElement("a");
    link.href = "/claude";
    link.textContent = "all sessions";
    wrapper.appendChild(link);

    link.click();
    await Promise.resolve();

    expect(sendNavigateSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    // The sendNavigate URL should be /claude (no query).
    const arg = sendNavigateSpy.mock.calls[0][0];
    expect(arg).not.toContain("s=");
  });

  it("HTTP mode: same-pathname click uses fetch, not navigate (canSendNavigate=false)", async () => {
    // When canSendNavigate() returns false (HTTP mode), the interceptor
    // must NOT enter the same-pathname fast path, because pushState would
    // fire before sendNavigate is called and sendNavigate would bail early
    // — leaving the URL permanently ahead of server state with no WS
    // reconnect to recover it. The fix: fall through to a normal fetch.
    interceptor.teardownForWrapper(wrapper.getAttribute("data-lvt-id"));

    const httpCtx: LinkInterceptorContext = {
      getWrapperElement: () => wrapper,
      handleNavigationResponse: handleNavigationResponseSpy,
      sendNavigate: sendNavigateSpy,
      canSendNavigate: () => false, // HTTP mode
    };
    const httpInterceptor = new LinkInterceptor(httpCtx, silentLogger);
    httpInterceptor.setup(wrapper);

    const link = document.createElement("a");
    link.href = "/claude?s=new-session";
    wrapper.appendChild(link);

    link.click();
    await Promise.resolve();

    // Must use fetch (not sendNavigate) even though pathname matches.
    expect(sendNavigateSpy).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    httpInterceptor.teardownForWrapper(wrapper.getAttribute("data-lvt-id"));
  });
});
