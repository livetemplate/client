import { LiveTemplateClient } from "../livetemplate-client";

describe("handleNavigationResponse", () => {
  let client: LiveTemplateClient;
  let wrapper: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = ""; // safe: test cleanup, matches existing pattern
    document.title = "Initial Title";

    wrapper = document.createElement("div");
    wrapper.setAttribute("data-lvt-id", "lvt-handler-a");
    wrapper.appendChild(document.createTextNode("Handler A content"));
    document.body.appendChild(wrapper);

    client = new LiveTemplateClient();
    (client as any).wrapperElement = wrapper;
  });

  afterEach(() => {
    document.body.innerHTML = ""; // safe: test cleanup
  });

  const callHandleNavigationResponse = (
    html: string,
    destinationHref: string = "https://example.com/"
  ) => {
    (client as any).handleNavigationResponse(html, destinationHref);
  };

  describe("same-handler navigation", () => {
    // handleNavigationResponse is only reachable via LinkInterceptor for
    // cross-pathname fetches. Same-pathname navigations (query-param change
    // on the same route) are caught by the fast path in link-interceptor.ts
    // and handled via sendNavigate() directly — no fetch, no call here.
    //
    // When handleNavigationResponse receives a same-handler-ID response
    // from a cross-pathname fetch, it falls through to the reconnect path
    // (same as a genuine handler switch). The in-band __navigate__ path for
    // same-pathname navigation is covered in navigate.test.ts.

    it("same-handler ID match from cross-path fetch triggers reconnect (not sendNavigate)", () => {
      // Regression guard: two different routes sharing the same data-lvt-id
      // must NOT call sendNavigate (which only ships query params, silently
      // dropping the path change). The correct behaviour is a full reconnect.
      const disconnectSpy = jest
        .spyOn(client, "disconnect")
        .mockImplementation(() => {});
      const connectSpy = jest
        .spyOn(client as any, "connect")
        .mockResolvedValue(undefined);
      const sendSpy = jest.spyOn(client, "send").mockImplementation(() => {});

      const html = [
        "<html><body>",
        '<div data-lvt-id="lvt-handler-a">',
        "<p>Content from /route-b</p>",
        "</div>",
        "</body></html>",
      ].join("");

      callHandleNavigationResponse(html);

      // sendNavigate must NOT have been called — that would drop the path.
      expect(sendSpy).not.toHaveBeenCalled();
      // Reconnect path must have fired instead.
      expect(disconnectSpy).toHaveBeenCalled();

      disconnectSpy.mockRestore();
      connectSpy.mockRestore();
      sendSpy.mockRestore();
    });

    it("preserves wrapper element identity", () => {
      const originalWrapper = wrapper;
      const sendSpy = jest.spyOn(client, "send").mockImplementation(() => {});

      const html = [
        "<html><body>",
        '<div data-lvt-id="lvt-handler-a">',
        "<p>New content</p>",
        "</div>",
        "</body></html>",
      ].join("");

      callHandleNavigationResponse(html);

      expect((client as any).wrapperElement).toBe(originalWrapper);
      sendSpy.mockRestore();
    });
  });

  describe("cross-handler navigation", () => {
    it("updates wrapper ID when response has different data-lvt-id", () => {
      const disconnectSpy = jest
        .spyOn(client, "disconnect")
        .mockImplementation(() => {});
      const connectSpy = jest
        .spyOn(client, "connect")
        .mockResolvedValue(undefined);

      const html = [
        "<html><body>",
        '<div data-lvt-id="lvt-handler-b">',
        "<p>Handler B content</p>",
        "</div>",
        "</body></html>",
      ].join("");

      callHandleNavigationResponse(html);

      expect(wrapper.getAttribute("data-lvt-id")).toBe("lvt-handler-b");
      expect(wrapper.textContent).toContain("Handler B content");

      disconnectSpy.mockRestore();
      connectSpy.mockRestore();
    });

    it("disconnects old handler", () => {
      const disconnectSpy = jest
        .spyOn(client, "disconnect")
        .mockImplementation(() => {});
      const connectSpy = jest
        .spyOn(client, "connect")
        .mockResolvedValue(undefined);

      const html = [
        "<html><body>",
        '<div data-lvt-id="lvt-handler-b">',
        "<p>Handler B</p>",
        "</div>",
        "</body></html>",
      ].join("");

      callHandleNavigationResponse(html);

      expect(disconnectSpy).toHaveBeenCalledTimes(1);

      disconnectSpy.mockRestore();
      connectSpy.mockRestore();
    });

    it("reconnects to the new handler", () => {
      const disconnectSpy = jest
        .spyOn(client, "disconnect")
        .mockImplementation(() => {});
      const connectSpy = jest
        .spyOn(client, "connect")
        .mockResolvedValue(undefined);

      const html = [
        "<html><body>",
        '<div data-lvt-id="lvt-handler-b">',
        "<p>Handler B</p>",
        "</div>",
        "</body></html>",
      ].join("");

      callHandleNavigationResponse(html);

      expect(connectSpy).toHaveBeenCalledWith(
        '[data-lvt-id="lvt-handler-b"]'
      );

      disconnectSpy.mockRestore();
      connectSpy.mockRestore();
    });

    it("falls back to page reload if reconnect fails", () => {
      const disconnectSpy = jest
        .spyOn(client, "disconnect")
        .mockImplementation(() => {});
      const connectSpy = jest
        .spyOn(client, "connect")
        .mockRejectedValue(new Error("connection failed"));

      const html = [
        "<html><body>",
        '<div data-lvt-id="lvt-handler-b">',
        "<p>Handler B</p>",
        "</div>",
        "</body></html>",
      ].join("");

      expect(() => callHandleNavigationResponse(html)).not.toThrow();
      expect(disconnectSpy).toHaveBeenCalled();
      expect(connectSpy).toHaveBeenCalled();

      disconnectSpy.mockRestore();
      connectSpy.mockRestore();
    });

    it("cleans up stale event listeners from old wrapper ID", () => {
      const disconnectSpy = jest
        .spyOn(client, "disconnect")
        .mockImplementation(() => {});
      const connectSpy = jest
        .spyOn(client, "connect")
        .mockResolvedValue(undefined);

      // Simulate an existing listener keyed to old wrapper ID
      const oldListener = jest.fn();
      (document as any)["__lvt_link_intercept_lvt-handler-a"] = oldListener;
      document.addEventListener("click", oldListener);

      const html = [
        "<html><body>",
        '<div data-lvt-id="lvt-handler-b">',
        "<p>Handler B</p>",
        "</div>",
        "</body></html>",
      ].join("");

      callHandleNavigationResponse(html);

      // Old listener key should be removed
      expect(
        (document as any)["__lvt_link_intercept_lvt-handler-a"]
      ).toBeUndefined();

      disconnectSpy.mockRestore();
      connectSpy.mockRestore();
    });

    it("sets up event delegation and link interception immediately (before async connect)", () => {
      const disconnectSpy = jest
        .spyOn(client, "disconnect")
        .mockImplementation(() => {});
      // Make connect() return a promise that never resolves to prove the
      // synchronous setup happens regardless of whether connect completes
      const connectSpy = jest
        .spyOn(client, "connect")
        .mockReturnValue(new Promise(() => {}));
      // Spy on the real internal setup methods
      const eventSetupSpy = jest.spyOn(
        (client as any).eventDelegator,
        "setupEventDelegation"
      );
      const linkSetupSpy = jest.spyOn(
        (client as any).linkInterceptor,
        "setup"
      );

      const html = [
        "<html><body>",
        '<div data-lvt-id="lvt-handler-b">',
        "<p>Handler B</p>",
        "</div>",
        "</body></html>",
      ].join("");

      callHandleNavigationResponse(html);

      // Both setup methods must have been called synchronously
      expect(eventSetupSpy).toHaveBeenCalled();
      expect(linkSetupSpy).toHaveBeenCalled();

      disconnectSpy.mockRestore();
      connectSpy.mockRestore();
      eventSetupSpy.mockRestore();
      linkSetupSpy.mockRestore();
    });

    it("scrolls to top on cross-handler navigation", () => {
      const disconnectSpy = jest
        .spyOn(client, "disconnect")
        .mockImplementation(() => {});
      const connectSpy = jest
        .spyOn(client, "connect")
        .mockResolvedValue(undefined);
      const scrollSpy = jest
        .spyOn(window, "scrollTo")
        .mockImplementation(() => {});

      const html = [
        "<html><body>",
        '<div data-lvt-id="lvt-handler-b">',
        "<p>Handler B</p>",
        "</div>",
        "</body></html>",
      ].join("");

      callHandleNavigationResponse(html);

      expect(scrollSpy).toHaveBeenCalledWith(0, 0);

      disconnectSpy.mockRestore();
      connectSpy.mockRestore();
      scrollSpy.mockRestore();
    });
  });

  describe("title updates", () => {
    it("updates document.title from response", () => {
      const html = [
        "<html><head><title>New Page Title</title></head><body>",
        '<div data-lvt-id="lvt-handler-a">',
        "<p>Content</p>",
        "</div>",
        "</body></html>",
      ].join("");

      callHandleNavigationResponse(html);

      expect(document.title).toBe("New Page Title");
    });

    it("updates title on cross-handler navigation", () => {
      const disconnectSpy = jest
        .spyOn(client, "disconnect")
        .mockImplementation(() => {});
      const connectSpy = jest
        .spyOn(client, "connect")
        .mockResolvedValue(undefined);

      const html = [
        "<html><head><title>Handler B Title</title></head><body>",
        '<div data-lvt-id="lvt-handler-b">',
        "<p>Handler B</p>",
        "</div>",
        "</body></html>",
      ].join("");

      callHandleNavigationResponse(html);

      expect(document.title).toBe("Handler B Title");

      disconnectSpy.mockRestore();
      connectSpy.mockRestore();
    });

    it("does not change title when response has no title element", () => {
      const html = [
        "<html><body>",
        '<div data-lvt-id="lvt-handler-a">',
        "<p>No title page</p>",
        "</div>",
        "</body></html>",
      ].join("");

      callHandleNavigationResponse(html);

      expect(document.title).toBe("Initial Title");
    });
  });

  describe("non-LiveTemplate response", () => {
    it("uses body content when response has no data-lvt-id wrapper", () => {
      const disconnectSpy = jest
        .spyOn(client, "disconnect")
        .mockImplementation(() => {});

      const html = [
        "<html><body>",
        "<div><p>Plain HTML page</p></div>",
        "</body></html>",
      ].join("");

      callHandleNavigationResponse(html);

      expect(wrapper.textContent).toContain("Plain HTML page");
      expect(wrapper.getAttribute("data-lvt-id")).toBe("lvt-handler-a");

      disconnectSpy.mockRestore();
    });

    it("disconnects old WebSocket on non-LiveTemplate fallback", () => {
      const disconnectSpy = jest
        .spyOn(client, "disconnect")
        .mockImplementation(() => {});

      const html = [
        "<html><body>",
        "<div><p>Plain HTML page</p></div>",
        "</body></html>",
      ].join("");

      callHandleNavigationResponse(html);

      expect(disconnectSpy).toHaveBeenCalledTimes(1);

      disconnectSpy.mockRestore();
    });

    it("tears down stale listeners on non-LiveTemplate fallback", () => {
      const disconnectSpy = jest
        .spyOn(client, "disconnect")
        .mockImplementation(() => {});
      // Spy on teardownForWrapper to verify it's called with the old ID
      const linkTeardownSpy = jest.spyOn(
        (client as any).linkInterceptor,
        "teardownForWrapper"
      );
      const eventTeardownSpy = jest.spyOn(
        (client as any).eventDelegator,
        "teardownForWrapper"
      );

      const html = [
        "<html><body>",
        "<div><p>Plain HTML page</p></div>",
        "</body></html>",
      ].join("");

      callHandleNavigationResponse(html);

      // Both teardown methods must be called with the old wrapper ID
      // before the fallback path re-registers listeners.
      expect(linkTeardownSpy).toHaveBeenCalledWith("lvt-handler-a");
      expect(eventTeardownSpy).toHaveBeenCalledWith("lvt-handler-a");

      disconnectSpy.mockRestore();
      linkTeardownSpy.mockRestore();
      eventTeardownSpy.mockRestore();
    });
  });

  describe("edge cases", () => {
    it("handles empty response body gracefully", () => {
      const html = "<html><body></body></html>";
      expect(() => callHandleNavigationResponse(html)).not.toThrow();
    });

    it("does nothing when wrapperElement is null", () => {
      (client as any).wrapperElement = null;
      expect(() =>
        callHandleNavigationResponse("<html><body></body></html>")
      ).not.toThrow();
    });
  });

  describe("cross-app boundary (different stylesheets)", () => {
    // Real-world repro from livetemplate.fly.dev: a docs site reverse-proxies
    // a separately-deployed app at /patterns/*. Each app owns its <head>
    // (different <link rel="stylesheet"> URLs). Without this guard, clicking
    // a link from the proxied app back to the docs root patches the docs body
    // into a page whose head still references the proxied app's stylesheets,
    // producing a broken layout that "fixes itself on refresh."

    beforeEach(() => {
      // Pre-populate the current document head with the "originating" app's
      // stylesheet, then have the fetched doc declare a different one.
      const link = document.createElement("link");
      link.setAttribute("rel", "stylesheet");
      link.setAttribute("href", "https://example.com/assets/lt-patterns.css");
      document.head.appendChild(link);
    });

    afterEach(() => {
      document.head.querySelectorAll('link[rel="stylesheet"]').forEach((l) => l.remove());
    });

    it("triggers a full navigation when fetched HTML declares a different set of stylesheets", () => {
      const performNavSpy = jest
        .spyOn(client as any, "performFullNavigation")
        .mockImplementation(() => {});
      const disconnectSpy = jest
        .spyOn(client, "disconnect")
        .mockImplementation(() => {});

      const html = [
        "<html>",
        "<head>",
        '  <link rel="stylesheet" href="https://example.com/assets/docs-site.css">',
        "</head>",
        "<body>",
        '  <div data-lvt-id="lvt-handler-a">',
        "    <p>Docs root content</p>",
        "  </div>",
        "</body>",
        "</html>",
      ].join("\n");

      callHandleNavigationResponse(html, "https://example.com/docs/intro");

      // Cross-app boundary: full navigation called with the destination
      // URL (NOT reload(), which would silently rely on caller-set
      // window.location ordering — see PR #119 review).
      expect(performNavSpy).toHaveBeenCalledWith("https://example.com/docs/intro");
      // Body swap path NOT taken: disconnect serves as the proxy signal
      // for "we proceeded into the swap path", and it must not have run.
      expect(disconnectSpy).not.toHaveBeenCalled();
      // Wrapper content unchanged — confirms we early-returned BEFORE
      // replaceChildren, so the page can't enter a half-swapped state.
      expect(wrapper.textContent).toContain("Handler A content");
    });

    it("performs body swap when fetched HTML has the same stylesheets", () => {
      // Within-app navigation: same head, body swap is the correct
      // optimization. This is the path that the cross-app guard must
      // not regress.
      const disconnectSpy = jest
        .spyOn(client, "disconnect")
        .mockImplementation(() => {});
      jest.spyOn(client as any, "connect").mockResolvedValue(undefined);

      const html = [
        "<html>",
        "<head>",
        '  <link rel="stylesheet" href="https://example.com/assets/lt-patterns.css">',
        "</head>",
        "<body>",
        '  <div data-lvt-id="lvt-handler-b">',
        "    <p>Same-app new route</p>",
        "  </div>",
        "</body>",
        "</html>",
      ].join("\n");

      callHandleNavigationResponse(html);

      // disconnect() was called — the body swap path proceeded
      expect(disconnectSpy).toHaveBeenCalled();
    });
  });
});
