import {
  handleScrollDirectives,
  handleHighlightDirectives,
  handleAnimateDirectives,
  setupFxDOMEventTriggers,
} from "../dom/directives";

describe("handleScrollDirectives", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("scrolls element to bottom when lvt-fx:scroll='bottom'", () => {
    document.body.innerHTML = `
      <div id="container" lvt-fx:scroll="bottom" style="height: 100px; overflow: auto;">
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

  it("scrolls to top when lvt-fx:scroll='top'", () => {
    document.body.innerHTML = `<div id="container" lvt-fx:scroll="top"></div>`;
    const container = document.getElementById("container")!;
    const scrollToSpy = jest.fn();
    container.scrollTo = scrollToSpy;

    handleScrollDirectives(document.body);

    expect(scrollToSpy).toHaveBeenCalledWith({
      top: 0,
      behavior: "auto",
    });
  });

  it("respects --lvt-scroll-behavior custom property", () => {
    document.body.innerHTML = `<div id="container" lvt-fx:scroll="top" style="--lvt-scroll-behavior: smooth;"></div>`;
    const container = document.getElementById("container")!;
    const scrollToSpy = jest.fn();
    container.scrollTo = scrollToSpy;

    handleScrollDirectives(document.body);

    expect(scrollToSpy).toHaveBeenCalledWith({
      top: 0,
      behavior: "smooth",
    });
  });

  it("bottom-sticky scrolls unconditionally on first encounter", () => {
    document.body.replaceChildren();
    const container = document.createElement("div");
    container.id = "container";
    container.setAttribute("lvt-fx:scroll", "bottom-sticky");
    container.style.setProperty("--lvt-scroll-threshold", "50");
    document.body.appendChild(container);
    Object.defineProperty(container, "scrollHeight", { value: 500, configurable: true });
    Object.defineProperty(container, "scrollTop", { value: 0, configurable: true });
    Object.defineProperty(container, "clientHeight", { value: 100, configurable: true });

    const scrollToSpy = jest.fn();
    container.scrollTo = scrollToSpy;

    handleScrollDirectives(document.body);

    expect(scrollToSpy).toHaveBeenCalledWith({ top: 500, behavior: "instant" });
    expect(container.dataset.lvtScrollSticky).toBe("1");
  });

  it("bottom-sticky scrolls when near bottom after initialization", () => {
    document.body.replaceChildren();
    const container = document.createElement("div");
    container.id = "container";
    container.setAttribute("lvt-fx:scroll", "bottom-sticky");
    container.style.setProperty("--lvt-scroll-threshold", "50");
    container.dataset.lvtScrollSticky = "1";
    document.body.appendChild(container);
    Object.defineProperty(container, "scrollHeight", { value: 500, configurable: true });
    Object.defineProperty(container, "scrollTop", { value: 400, configurable: true });
    Object.defineProperty(container, "clientHeight", { value: 100, configurable: true });

    const scrollToSpy = jest.fn();
    container.scrollTo = scrollToSpy;

    handleScrollDirectives(document.body);

    expect(scrollToSpy).toHaveBeenCalled();
  });

  it("bottom-sticky does not scroll when far from bottom after initialization", () => {
    document.body.replaceChildren();
    const container = document.createElement("div");
    container.id = "container";
    container.setAttribute("lvt-fx:scroll", "bottom-sticky");
    container.style.setProperty("--lvt-scroll-threshold", "50");
    container.dataset.lvtScrollSticky = "1";
    document.body.appendChild(container);
    Object.defineProperty(container, "scrollHeight", { value: 500, configurable: true });
    Object.defineProperty(container, "scrollTop", { value: 0, configurable: true });
    Object.defineProperty(container, "clientHeight", { value: 100, configurable: true });

    const scrollToSpy = jest.fn();
    container.scrollTo = scrollToSpy;

    handleScrollDirectives(document.body);

    expect(scrollToSpy).not.toHaveBeenCalled();
  });

  it("does nothing for lvt-fx:scroll='preserve'", () => {
    document.body.innerHTML = `<div id="container" lvt-fx:scroll="preserve"></div>`;
    const container = document.getElementById("container")!;
    const scrollToSpy = jest.fn();
    container.scrollTo = scrollToSpy;

    handleScrollDirectives(document.body);

    expect(scrollToSpy).not.toHaveBeenCalled();
  });

  it("warns on unknown scroll mode", () => {
    document.body.innerHTML = `<div id="container" lvt-fx:scroll="unknown-mode"></div>`;

    handleScrollDirectives(document.body);

    expect(console.warn).toHaveBeenCalledWith("Unknown lvt-fx:scroll mode: unknown-mode");
  });

  it("handles empty lvt-fx:scroll attribute", () => {
    document.body.innerHTML = `<div id="container" lvt-fx:scroll=""></div>`;
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
    document.body.innerHTML = `<div id="target" lvt-fx:highlight="flash"></div>`;
    const target = document.getElementById("target")!;

    handleHighlightDirectives(document.body);

    expect(target.style.backgroundColor).toBe("rgb(255, 193, 7)"); // #ffc107
    expect(target.style.transition).toContain("background-color");
  });

  it("respects custom --lvt-highlight-duration", () => {
    document.body.innerHTML = `<div id="target" lvt-fx:highlight="flash" style="--lvt-highlight-duration: 1000;"></div>`;
    const target = document.getElementById("target")!;

    handleHighlightDirectives(document.body);

    expect(target.style.transition).toContain("1000ms");
  });

  it("respects custom --lvt-highlight-color", () => {
    document.body.innerHTML = `<div id="target" lvt-fx:highlight="flash" style="--lvt-highlight-color: #ff0000;"></div>`;
    const target = document.getElementById("target")!;

    handleHighlightDirectives(document.body);

    expect(target.style.backgroundColor).toBe("rgb(255, 0, 0)");
  });

  it("restores original background after highlight", () => {
    document.body.innerHTML = `<div id="target" lvt-fx:highlight="flash" style="background-color: blue;"></div>`;
    const target = document.getElementById("target")!;
    const originalBg = target.style.backgroundColor;

    handleHighlightDirectives(document.body);

    // After 50ms, should start restoring
    jest.advanceTimersByTime(50);
    expect(target.style.backgroundColor).toBe(originalBg);

    // After duration, transition should be restored
    jest.advanceTimersByTime(500);
  });

  it("handles empty lvt-fx:highlight attribute", () => {
    document.body.innerHTML = `<div id="target" lvt-fx:highlight=""></div>`;
    const target = document.getElementById("target")!;
    const originalBg = target.style.backgroundColor;

    handleHighlightDirectives(document.body);

    expect(target.style.backgroundColor).toBe(originalBg);
  });

  it("removes empty style attribute after cleanup", () => {
    document.body.innerHTML = `<div id="target" lvt-fx:highlight="flash"></div>`;
    const target = document.getElementById("target")!;

    handleHighlightDirectives(document.body);

    // While the highlight is in flight, the directive's transition + bg are
    // present, so style attribute exists.
    expect(target.hasAttribute("style")).toBe(true);

    // Advance past the inner setTimeout (50ms initial + 500ms duration default)
    jest.advanceTimersByTime(50);
    jest.advanceTimersByTime(500);

    // After full cycle: directive's bg + transition removed; nothing user-set
    // remains on this element, so style attribute is gone.
    expect(target.hasAttribute("style")).toBe(false);
  });

  it("preserves style attribute when user-set CSS vars remain after cleanup", () => {
    document.body.innerHTML = `<div id="target" lvt-fx:highlight="flash" style="--lvt-highlight-color: #ff0000;"></div>`;
    const target = document.getElementById("target")!;

    handleHighlightDirectives(document.body);

    jest.advanceTimersByTime(50);
    jest.advanceTimersByTime(500);

    // Directive's own properties cleared, but the user's --lvt-highlight-color
    // CSS var must survive — style.length>0 keeps the attribute.
    expect(target.hasAttribute("style")).toBe(true);
    expect(target.style.getPropertyValue("--lvt-highlight-color")).toBe("#ff0000");
  });

  it("removes empty style attribute when element disconnects mid-cycle", () => {
    document.body.innerHTML = `<div id="target" lvt-fx:highlight="flash"></div>`;
    const target = document.getElementById("target")!;

    handleHighlightDirectives(document.body);

    // Disconnect before the inner setTimeout fires (between 0 and 50ms)
    target.remove();
    jest.advanceTimersByTime(50);

    // Even on the disconnected path, cleanup should leave no empty style attr
    expect(target.hasAttribute("style")).toBe(false);
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
    document.body.innerHTML = `<div id="target" lvt-fx:animate="fade"></div>`;
    const target = document.getElementById("target")!;

    handleAnimateDirectives(document.body);

    expect(target.style.animation).toContain("lvt-fade-in");
  });

  it("applies slide animation", () => {
    document.body.innerHTML = `<div id="target" lvt-fx:animate="slide"></div>`;
    const target = document.getElementById("target")!;

    handleAnimateDirectives(document.body);

    expect(target.style.animation).toContain("lvt-slide-in");
  });

  it("applies scale animation", () => {
    document.body.innerHTML = `<div id="target" lvt-fx:animate="scale"></div>`;
    const target = document.getElementById("target")!;

    handleAnimateDirectives(document.body);

    expect(target.style.animation).toContain("lvt-scale-in");
  });

  it("respects custom animation duration via CSS custom property", () => {
    document.body.innerHTML = `<div id="target" lvt-fx:animate="fade" style="--lvt-animate-duration: 1000;"></div>`;
    const target = document.getElementById("target")!;

    handleAnimateDirectives(document.body);

    // The directive inlines the duration directly into the animation
    // shorthand rather than writing back a sanitized custom property.
    // This prevents a phantom --lvt-animate-duration inline property
    // from lingering after animationend cleanup.
    expect(target.style.animation).toContain("1000ms");
    expect(target.style.animation).toContain("lvt-fade-in");
  });

  it("clears animation on animationend", () => {
    document.body.innerHTML = `<div id="target" lvt-fx:animate="fade"></div>`;
    const target = document.getElementById("target")!;

    handleAnimateDirectives(document.body);

    expect(target.style.animation).toContain("lvt-fade-in");

    target.dispatchEvent(new Event("animationend"));

    expect(target.style.animation).toBe("");
  });

  it("removes style attribute entirely on animationend when no other styles remain", () => {
    // Build the element via DOM APIs (innerHTML would trigger our project's
    // XSS reminder hook in tests). Attribute setup is equivalent.
    document.body.replaceChildren();
    const target = document.createElement("div");
    target.id = "target";
    target.setAttribute("lvt-fx:animate", "fade");
    document.body.appendChild(target);

    handleAnimateDirectives(document.body);
    // Before animationend: style="animation: lvt-fade-in ...;"
    expect(target.hasAttribute("style")).toBe(true);

    target.dispatchEvent(new Event("animationend"));

    // After animationend: style attribute fully removed so downstream
    // inline-style checks see a clean element. This is the fix that lets
    // patterns-app UI standards validation succeed on animated rows.
    expect(target.hasAttribute("style")).toBe(false);
  });

  it("injects CSS keyframes only once", () => {
    document.body.innerHTML = `
      <div lvt-fx:animate="fade"></div>
      <div lvt-fx:animate="slide"></div>
    `;

    handleAnimateDirectives(document.body);
    handleAnimateDirectives(document.body);

    const styleElements = document.querySelectorAll("#lvt-animate-styles");
    expect(styleElements.length).toBe(1);
  });

  it("warns on unknown animation mode", () => {
    document.body.innerHTML = `<div id="target" lvt-fx:animate="unknown"></div>`;

    handleAnimateDirectives(document.body);

    expect(console.warn).toHaveBeenCalledWith("Unknown lvt-fx:animate mode: unknown");
  });

  it("handles empty lvt-animate attribute", () => {
    document.body.innerHTML = `<div id="target" lvt-fx:animate=""></div>`;
    const target = document.getElementById("target")!;

    handleAnimateDirectives(document.body);

    expect(target.style.animation).toBe("");
  });
});

describe("setupFxDOMEventTriggers", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("attaches highlight effect on click trigger", () => {
    const target = document.createElement("div");
    target.setAttribute("lvt-fx:highlight:on:click", "flash");
    document.body.appendChild(target);

    setupFxDOMEventTriggers(document.body);
    target.click();

    expect(target.style.backgroundColor).not.toBe("");
  });

  it("does not fire for implicit trigger (no :on:)", () => {
    const target = document.createElement("div");
    target.setAttribute("lvt-fx:highlight", "flash");
    document.body.appendChild(target);

    setupFxDOMEventTriggers(document.body);
    target.click();

    expect(target.style.backgroundColor).toBe("");
  });

  it("does not fire for lifecycle trigger", () => {
    const target = document.createElement("div");
    target.setAttribute("lvt-fx:highlight:on:success", "flash");
    document.body.appendChild(target);

    setupFxDOMEventTriggers(document.body);
    target.click();

    expect(target.style.backgroundColor).toBe("");
  });

  it("attaches mouseenter trigger for highlight", () => {
    const target = document.createElement("div");
    target.setAttribute("lvt-fx:highlight:on:mouseenter", "flash");
    document.body.appendChild(target);

    setupFxDOMEventTriggers(document.body);
    target.dispatchEvent(new MouseEvent("mouseenter"));

    expect(target.style.backgroundColor).not.toBe("");
  });

  it("resolves data-lvt-target for scroll effect on click", () => {
    const container = document.createElement("div");
    container.id = "chat-log";
    Object.defineProperty(container, "scrollHeight", { value: 500, configurable: true });
    const scrollToSpy = jest.fn();
    container.scrollTo = scrollToSpy;
    document.body.appendChild(container);

    const button = document.createElement("button");
    button.setAttribute("lvt-fx:scroll:on:click", "bottom");
    button.setAttribute("data-lvt-target", "#chat-log");
    document.body.appendChild(button);

    setupFxDOMEventTriggers(document.body);
    button.click();

    expect(scrollToSpy).toHaveBeenCalledWith({
      top: 500,
      behavior: "auto",
    });
  });

  it("resolves data-lvt-target for highlight effect on click", () => {
    const target = document.createElement("div");
    target.id = "my-target";
    document.body.appendChild(target);

    const trigger = document.createElement("button");
    trigger.setAttribute("lvt-fx:highlight:on:click", "flash");
    trigger.setAttribute("data-lvt-target", "#my-target");
    document.body.appendChild(trigger);

    setupFxDOMEventTriggers(document.body);
    trigger.click();

    expect(target.style.backgroundColor).not.toBe("");
    expect(trigger.style.backgroundColor).toBe("");
  });
});
