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

  const callHandleNavigationResponse = (html: string) => {
    (client as any).handleNavigationResponse(html);
  };

  describe("same-handler navigation", () => {
    it("replaces wrapper children when response has same data-lvt-id", () => {
      const html = [
        "<html><head><title>Same Page</title></head><body>",
        '<div data-lvt-id="lvt-handler-a">',
        "<p>Updated content from same handler</p>",
        "</div>",
        "</body></html>",
      ].join("");

      callHandleNavigationResponse(html);

      expect(wrapper.textContent).toContain("Updated content from same handler");
      expect(wrapper.getAttribute("data-lvt-id")).toBe("lvt-handler-a");
    });

    it("preserves wrapper element identity", () => {
      const originalWrapper = wrapper;
      const html = [
        "<html><body>",
        '<div data-lvt-id="lvt-handler-a">',
        "<p>New content</p>",
        "</div>",
        "</body></html>",
      ].join("");

      callHandleNavigationResponse(html);

      expect((client as any).wrapperElement).toBe(originalWrapper);
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
});
