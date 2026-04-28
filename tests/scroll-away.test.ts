import { setupScrollAway, teardownScrollAway } from "../dom/scroll-away";

function mockScrollableElement(
  id: string,
  props: { scrollHeight: number; scrollTop: number; clientHeight: number }
): HTMLDivElement {
  const el = document.createElement("div");
  el.id = id;
  Object.defineProperty(el, "scrollHeight", { value: props.scrollHeight, configurable: true });
  Object.defineProperty(el, "scrollTop", { value: props.scrollTop, configurable: true, writable: true });
  Object.defineProperty(el, "clientHeight", { value: props.clientHeight, configurable: true });
  return el;
}

describe("setupScrollAway", () => {
  let rafCallbacks: FrameRequestCallback[];

  beforeEach(() => {
    document.body.replaceChildren();
    rafCallbacks = [];
    jest.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    teardownScrollAway();
    jest.restoreAllMocks();
  });

  function flushRAF() {
    const cbs = rafCallbacks.splice(0);
    cbs.forEach((cb) => cb(performance.now()));
  }

  it("adds 'visible' class when scrolled away from bottom", () => {
    const container = mockScrollableElement("chat-log", {
      scrollHeight: 1000,
      scrollTop: 0,
      clientHeight: 400,
    });
    document.body.appendChild(container);

    const button = document.createElement("button");
    button.setAttribute("lvt-scroll-away", "bottom");
    button.setAttribute("data-lvt-target", "#chat-log");
    document.body.appendChild(button);

    setupScrollAway(document.body);
    flushRAF();

    expect(button.classList.contains("visible")).toBe(true);
  });

  it("removes 'visible' class when at bottom", () => {
    const container = mockScrollableElement("chat-log", {
      scrollHeight: 1000,
      scrollTop: 600,
      clientHeight: 400,
    });
    document.body.appendChild(container);

    const button = document.createElement("button");
    button.setAttribute("lvt-scroll-away", "bottom");
    button.setAttribute("data-lvt-target", "#chat-log");
    document.body.appendChild(button);

    setupScrollAway(document.body);
    flushRAF();

    expect(button.classList.contains("visible")).toBe(false);
  });

  it("toggles on scroll events", () => {
    const container = mockScrollableElement("chat-log", {
      scrollHeight: 1000,
      scrollTop: 600,
      clientHeight: 400,
    });
    document.body.appendChild(container);

    const button = document.createElement("button");
    button.setAttribute("lvt-scroll-away", "bottom");
    button.setAttribute("data-lvt-target", "#chat-log");
    document.body.appendChild(button);

    setupScrollAway(document.body);
    flushRAF();
    expect(button.classList.contains("visible")).toBe(false);

    Object.defineProperty(container, "scrollTop", { value: 0, configurable: true });
    container.dispatchEvent(new Event("scroll"));
    flushRAF();
    expect(button.classList.contains("visible")).toBe(true);

    Object.defineProperty(container, "scrollTop", { value: 600, configurable: true });
    container.dispatchEvent(new Event("scroll"));
    flushRAF();
    expect(button.classList.contains("visible")).toBe(false);
  });

  it("uses default threshold of 200 when no CSS property set", () => {
    const container = mockScrollableElement("chat-log", {
      scrollHeight: 1000,
      scrollTop: 700,
      clientHeight: 100,
    });
    document.body.appendChild(container);

    const button = document.createElement("button");
    button.setAttribute("lvt-scroll-away", "bottom");
    button.setAttribute("data-lvt-target", "#chat-log");
    document.body.appendChild(button);

    setupScrollAway(document.body);
    flushRAF();

    // distance = 1000 - 700 - 100 = 200, which is NOT > 200
    expect(button.classList.contains("visible")).toBe(false);
  });

  it("warns and skips when no target resolves (self-target)", () => {
    const button = document.createElement("button");
    button.setAttribute("lvt-scroll-away", "bottom");
    document.body.appendChild(button);

    setupScrollAway(document.body);

    expect((button as any).__lvt_scroll_away).toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(
      "lvt-scroll-away requires data-lvt-target pointing to a scrollable container"
    );
  });

  it("warns on unknown edge value", () => {
    const container = mockScrollableElement("chat-log", {
      scrollHeight: 1000,
      scrollTop: 0,
      clientHeight: 400,
    });
    document.body.appendChild(container);

    const button = document.createElement("button");
    button.setAttribute("lvt-scroll-away", "left");
    button.setAttribute("data-lvt-target", "#chat-log");
    document.body.appendChild(button);

    setupScrollAway(document.body);

    expect(console.warn).toHaveBeenCalledWith("Unknown lvt-scroll-away edge: left");
  });

  describe('edge="top" (scroll-to-top semantics)', () => {
    it("adds 'visible' class when scrolled away from top", () => {
      const container = mockScrollableElement("article-body", {
        scrollHeight: 1000,
        scrollTop: 600,
        clientHeight: 400,
      });
      document.body.appendChild(container);

      const button = document.createElement("button");
      button.setAttribute("lvt-scroll-away", "top");
      button.setAttribute("data-lvt-target", "#article-body");
      document.body.appendChild(button);

      setupScrollAway(document.body);
      flushRAF();

      expect(button.classList.contains("visible")).toBe(true);
    });

    it("removes 'visible' class when at top", () => {
      const container = mockScrollableElement("article-body", {
        scrollHeight: 1000,
        scrollTop: 0,
        clientHeight: 400,
      });
      document.body.appendChild(container);

      const button = document.createElement("button");
      button.setAttribute("lvt-scroll-away", "top");
      button.setAttribute("data-lvt-target", "#article-body");
      document.body.appendChild(button);

      setupScrollAway(document.body);
      flushRAF();

      expect(button.classList.contains("visible")).toBe(false);
    });

    it("toggles on scroll events with top-edge semantics", () => {
      const container = mockScrollableElement("article-body", {
        scrollHeight: 1000,
        scrollTop: 0,
        clientHeight: 400,
      });
      document.body.appendChild(container);

      const button = document.createElement("button");
      button.setAttribute("lvt-scroll-away", "top");
      button.setAttribute("data-lvt-target", "#article-body");
      document.body.appendChild(button);

      setupScrollAway(document.body);
      flushRAF();
      expect(button.classList.contains("visible")).toBe(false);

      Object.defineProperty(container, "scrollTop", { value: 600, configurable: true });
      container.dispatchEvent(new Event("scroll"));
      flushRAF();
      expect(button.classList.contains("visible")).toBe(true);

      Object.defineProperty(container, "scrollTop", { value: 0, configurable: true });
      container.dispatchEvent(new Event("scroll"));
      flushRAF();
      expect(button.classList.contains("visible")).toBe(false);
    });

    it("respects threshold for top edge", () => {
      const container = mockScrollableElement("article-body", {
        scrollHeight: 1000,
        scrollTop: 200,
        clientHeight: 400,
      });
      document.body.appendChild(container);

      const button = document.createElement("button");
      button.setAttribute("lvt-scroll-away", "top");
      button.setAttribute("data-lvt-target", "#article-body");
      document.body.appendChild(button);

      setupScrollAway(document.body);
      flushRAF();

      // scrollTop = 200 is NOT > 200 default threshold
      expect(button.classList.contains("visible")).toBe(false);
    });

    it("becomes visible at threshold + 1 for top edge", () => {
      const container = mockScrollableElement("article-body", {
        scrollHeight: 1000,
        scrollTop: 201,
        clientHeight: 400,
      });
      document.body.appendChild(container);

      const button = document.createElement("button");
      button.setAttribute("lvt-scroll-away", "top");
      button.setAttribute("data-lvt-target", "#article-body");
      document.body.appendChild(button);

      setupScrollAway(document.body);
      flushRAF();

      // scrollTop = 201 IS > 200 default threshold
      expect(button.classList.contains("visible")).toBe(true);
    });
  });

  it("does not duplicate listeners on re-scan with same target", () => {
    const container = mockScrollableElement("chat-log", {
      scrollHeight: 1000,
      scrollTop: 0,
      clientHeight: 400,
    });
    document.body.appendChild(container);

    const button = document.createElement("button");
    button.setAttribute("lvt-scroll-away", "bottom");
    button.setAttribute("data-lvt-target", "#chat-log");
    document.body.appendChild(button);

    setupScrollAway(document.body);
    const firstBinding = (button as any).__lvt_scroll_away;

    setupScrollAway(document.body);
    const secondBinding = (button as any).__lvt_scroll_away;

    expect(firstBinding).toBe(secondBinding);
  });

  it("re-attaches listener when target element is replaced", () => {
    const container1 = mockScrollableElement("chat-log", {
      scrollHeight: 1000,
      scrollTop: 0,
      clientHeight: 400,
    });
    document.body.appendChild(container1);

    const button = document.createElement("button");
    button.setAttribute("lvt-scroll-away", "bottom");
    button.setAttribute("data-lvt-target", "#chat-log");
    document.body.appendChild(button);

    setupScrollAway(document.body);
    flushRAF();
    expect(button.classList.contains("visible")).toBe(true);

    // Replace the container (simulating morphdom replacement)
    container1.remove();
    const container2 = mockScrollableElement("chat-log", {
      scrollHeight: 500,
      scrollTop: 100,
      clientHeight: 400,
    });
    document.body.appendChild(container2);

    setupScrollAway(document.body);
    flushRAF();

    // distance = 500 - 100 - 400 = 0, not > 200
    expect(button.classList.contains("visible")).toBe(false);
  });

  it("teardown removes all listeners", () => {
    const container = mockScrollableElement("chat-log", {
      scrollHeight: 1000,
      scrollTop: 0,
      clientHeight: 400,
    });
    document.body.appendChild(container);

    const button = document.createElement("button");
    button.setAttribute("lvt-scroll-away", "bottom");
    button.setAttribute("data-lvt-target", "#chat-log");
    document.body.appendChild(button);

    setupScrollAway(document.body);
    flushRAF();
    expect(button.classList.contains("visible")).toBe(true);

    teardownScrollAway();
    expect((button as any).__lvt_scroll_away).toBeUndefined();

    button.classList.remove("visible");
    container.dispatchEvent(new Event("scroll"));
    flushRAF();

    // Listener removed: class should stay removed
    expect(button.classList.contains("visible")).toBe(false);
  });
});
