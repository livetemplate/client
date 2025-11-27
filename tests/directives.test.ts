import {
  handleScrollDirectives,
  handleHighlightDirectives,
  handleAnimateDirectives,
} from "../dom/directives";

describe("handleScrollDirectives", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("scrolls element to bottom when lvt-scroll='bottom'", () => {
    document.body.innerHTML = `
      <div id="container" lvt-scroll="bottom" style="height: 100px; overflow: auto;">
        <div style="height: 500px;">Content</div>
      </div>
    `;
    const container = document.getElementById("container")!;
    Object.defineProperty(container, "scrollHeight", { value: 500, configurable: true });

    const scrollToSpy = jest.fn();
    container.scrollTo = scrollToSpy;

    handleScrollDirectives(document.body);

    expect(scrollToSpy).toHaveBeenCalledWith({
      top: 500,
      behavior: "auto",
    });
  });

  it("scrolls to top when lvt-scroll='top'", () => {
    document.body.innerHTML = `<div id="container" lvt-scroll="top"></div>`;
    const container = document.getElementById("container")!;
    const scrollToSpy = jest.fn();
    container.scrollTo = scrollToSpy;

    handleScrollDirectives(document.body);

    expect(scrollToSpy).toHaveBeenCalledWith({
      top: 0,
      behavior: "auto",
    });
  });

  it("respects lvt-scroll-behavior attribute", () => {
    document.body.innerHTML = `<div id="container" lvt-scroll="top" lvt-scroll-behavior="smooth"></div>`;
    const container = document.getElementById("container")!;
    const scrollToSpy = jest.fn();
    container.scrollTo = scrollToSpy;

    handleScrollDirectives(document.body);

    expect(scrollToSpy).toHaveBeenCalledWith({
      top: 0,
      behavior: "smooth",
    });
  });

  it("sticky bottom only scrolls when near bottom", () => {
    document.body.innerHTML = `<div id="container" lvt-scroll="bottom-sticky" lvt-scroll-threshold="50"></div>`;
    const container = document.getElementById("container")!;
    Object.defineProperty(container, "scrollHeight", { value: 500, configurable: true });
    Object.defineProperty(container, "scrollTop", { value: 400, configurable: true });
    Object.defineProperty(container, "clientHeight", { value: 100, configurable: true });

    const scrollToSpy = jest.fn();
    container.scrollTo = scrollToSpy;

    handleScrollDirectives(document.body);

    // scrollHeight (500) - scrollTop (400) - clientHeight (100) = 0, which is <= threshold (50)
    expect(scrollToSpy).toHaveBeenCalled();
  });

  it("sticky bottom does not scroll when far from bottom", () => {
    document.body.innerHTML = `<div id="container" lvt-scroll="bottom-sticky" lvt-scroll-threshold="50"></div>`;
    const container = document.getElementById("container")!;
    Object.defineProperty(container, "scrollHeight", { value: 500, configurable: true });
    Object.defineProperty(container, "scrollTop", { value: 0, configurable: true });
    Object.defineProperty(container, "clientHeight", { value: 100, configurable: true });

    const scrollToSpy = jest.fn();
    container.scrollTo = scrollToSpy;

    handleScrollDirectives(document.body);

    // scrollHeight (500) - scrollTop (0) - clientHeight (100) = 400, which is > threshold (50)
    expect(scrollToSpy).not.toHaveBeenCalled();
  });

  it("does nothing for lvt-scroll='preserve'", () => {
    document.body.innerHTML = `<div id="container" lvt-scroll="preserve"></div>`;
    const container = document.getElementById("container")!;
    const scrollToSpy = jest.fn();
    container.scrollTo = scrollToSpy;

    handleScrollDirectives(document.body);

    expect(scrollToSpy).not.toHaveBeenCalled();
  });

  it("warns on unknown scroll mode", () => {
    document.body.innerHTML = `<div id="container" lvt-scroll="unknown-mode"></div>`;

    handleScrollDirectives(document.body);

    expect(console.warn).toHaveBeenCalledWith("Unknown lvt-scroll mode: unknown-mode");
  });

  it("handles empty lvt-scroll attribute", () => {
    document.body.innerHTML = `<div id="container" lvt-scroll=""></div>`;
    const container = document.getElementById("container")!;
    const scrollToSpy = jest.fn();
    container.scrollTo = scrollToSpy;

    handleScrollDirectives(document.body);

    expect(scrollToSpy).not.toHaveBeenCalled();
  });
});

describe("handleHighlightDirectives", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("applies highlight color temporarily", () => {
    document.body.innerHTML = `<div id="target" lvt-highlight="flash"></div>`;
    const target = document.getElementById("target")!;

    handleHighlightDirectives(document.body);

    expect(target.style.backgroundColor).toBe("rgb(255, 193, 7)"); // #ffc107
    expect(target.style.transition).toContain("background-color");
  });

  it("respects custom lvt-highlight-duration", () => {
    document.body.innerHTML = `<div id="target" lvt-highlight="flash" lvt-highlight-duration="1000"></div>`;
    const target = document.getElementById("target")!;

    handleHighlightDirectives(document.body);

    expect(target.style.transition).toContain("1000ms");
  });

  it("respects custom lvt-highlight-color", () => {
    document.body.innerHTML = `<div id="target" lvt-highlight="flash" lvt-highlight-color="#ff0000"></div>`;
    const target = document.getElementById("target")!;

    handleHighlightDirectives(document.body);

    expect(target.style.backgroundColor).toBe("rgb(255, 0, 0)");
  });

  it("restores original background after highlight", () => {
    document.body.innerHTML = `<div id="target" lvt-highlight="flash" lvt-highlight-duration="500" style="background-color: blue;"></div>`;
    const target = document.getElementById("target")!;
    const originalBg = target.style.backgroundColor;

    handleHighlightDirectives(document.body);

    // After 50ms, should start restoring
    jest.advanceTimersByTime(50);
    expect(target.style.backgroundColor).toBe(originalBg);

    // After duration, transition should be restored
    jest.advanceTimersByTime(500);
  });

  it("handles empty lvt-highlight attribute", () => {
    document.body.innerHTML = `<div id="target" lvt-highlight=""></div>`;
    const target = document.getElementById("target")!;
    const originalBg = target.style.backgroundColor;

    handleHighlightDirectives(document.body);

    expect(target.style.backgroundColor).toBe(originalBg);
  });
});

describe("handleAnimateDirectives", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    // Clean up any injected styles
    const existingStyle = document.getElementById("lvt-animate-styles");
    if (existingStyle) existingStyle.remove();
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("applies fade animation", () => {
    document.body.innerHTML = `<div id="target" lvt-animate="fade"></div>`;
    const target = document.getElementById("target")!;

    handleAnimateDirectives(document.body);

    expect(target.style.animation).toContain("lvt-fade-in");
  });

  it("applies slide animation", () => {
    document.body.innerHTML = `<div id="target" lvt-animate="slide"></div>`;
    const target = document.getElementById("target")!;

    handleAnimateDirectives(document.body);

    expect(target.style.animation).toContain("lvt-slide-in");
  });

  it("applies scale animation", () => {
    document.body.innerHTML = `<div id="target" lvt-animate="scale"></div>`;
    const target = document.getElementById("target")!;

    handleAnimateDirectives(document.body);

    expect(target.style.animation).toContain("lvt-scale-in");
  });

  it("respects custom animation duration", () => {
    document.body.innerHTML = `<div id="target" lvt-animate="fade" lvt-animate-duration="1000"></div>`;
    const target = document.getElementById("target")!;

    handleAnimateDirectives(document.body);

    expect(target.style.getPropertyValue("--lvt-animate-duration")).toBe("1000ms");
  });

  it("clears animation on animationend", () => {
    document.body.innerHTML = `<div id="target" lvt-animate="fade"></div>`;
    const target = document.getElementById("target")!;

    handleAnimateDirectives(document.body);

    expect(target.style.animation).toContain("lvt-fade-in");

    target.dispatchEvent(new Event("animationend"));

    expect(target.style.animation).toBe("");
  });

  it("injects CSS keyframes only once", () => {
    document.body.innerHTML = `
      <div lvt-animate="fade"></div>
      <div lvt-animate="slide"></div>
    `;

    handleAnimateDirectives(document.body);
    handleAnimateDirectives(document.body);

    const styleElements = document.querySelectorAll("#lvt-animate-styles");
    expect(styleElements.length).toBe(1);
  });

  it("warns on unknown animation mode", () => {
    document.body.innerHTML = `<div id="target" lvt-animate="unknown"></div>`;

    handleAnimateDirectives(document.body);

    expect(console.warn).toHaveBeenCalledWith("Unknown lvt-animate mode: unknown");
  });

  it("handles empty lvt-animate attribute", () => {
    document.body.innerHTML = `<div id="target" lvt-animate=""></div>`;
    const target = document.getElementById("target")!;

    handleAnimateDirectives(document.body);

    expect(target.style.animation).toBe("");
  });
});
