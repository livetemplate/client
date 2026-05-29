import {
  handleScrollDirectives,
  handleHighlightDirectives,
  handleAnimateDirectives,
  handleAreaSelectDirectives,
  handleAutoClickDirectives,
  handleShadowRootHydration,
  setupFxDOMEventTriggers,
  teardownAutoClickTimers,
  __resetAnimatedElementsForTesting,
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

  it("scrolls element into view when lvt-fx:scroll='into-view'", () => {
    document.body.innerHTML = `<div id="container" lvt-fx:scroll="into-view"></div>`;
    const container = document.getElementById("container")!;
    const scrollIntoViewSpy = jest.fn();
    container.scrollIntoView = scrollIntoViewSpy;

    handleScrollDirectives(document.body);

    expect(scrollIntoViewSpy).toHaveBeenCalledWith({
      block: "center",
      inline: "nearest",
      behavior: "auto",
    });
  });

  it("scroll='into-view' honors --lvt-scroll-behavior", () => {
    document.body.innerHTML = `<div id="container" lvt-fx:scroll="into-view" style="--lvt-scroll-behavior: smooth;"></div>`;
    const container = document.getElementById("container")!;
    const scrollIntoViewSpy = jest.fn();
    container.scrollIntoView = scrollIntoViewSpy;

    handleScrollDirectives(document.body);

    expect(scrollIntoViewSpy).toHaveBeenCalledWith({
      block: "center",
      inline: "nearest",
      behavior: "smooth",
    });
  });

  it("scroll='into-view' is one-shot per element (won't re-scroll on subsequent renders)", () => {
    document.body.innerHTML = `<div id="container" lvt-fx:scroll="into-view"></div>`;
    const container = document.getElementById("container")!;
    const scrollIntoViewSpy = jest.fn();
    container.scrollIntoView = scrollIntoViewSpy;

    handleScrollDirectives(document.body);
    handleScrollDirectives(document.body); // simulate a second render
    handleScrollDirectives(document.body); // and a third

    expect(scrollIntoViewSpy).toHaveBeenCalledTimes(1);
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

  describe("reset-on:<attr>", () => {
    it("resets scrollLeft and scrollTop when watched attribute changes", () => {
      document.body.innerHTML = `<div id="container" lvt-fx:scroll="reset-on:data-path" data-path="a.go"></div>`;
      const container = document.getElementById("container")!;

      handleScrollDirectives(document.body); // first paint — establishes prior
      container.scrollLeft = 200;
      container.scrollTop = 80;

      handleScrollDirectives(document.body); // same value — no reset
      expect(container.scrollLeft).toBe(200);
      expect(container.scrollTop).toBe(80);

      container.setAttribute("data-path", "b.go");
      handleScrollDirectives(document.body);
      expect(container.scrollLeft).toBe(0);
      expect(container.scrollTop).toBe(0);
    });

    it("preserves scroll on first paint (does not clobber pre-existing position)", () => {
      // Caller might have restored scroll from a session, deep link, or
      // anchor jump before the first directive sweep. The directive's
      // semantic is "reset on *change*" — establishing the prior on the
      // very first observation must not itself trigger a reset.
      document.body.innerHTML = `<div id="container" lvt-fx:scroll="reset-on:data-path" data-path="a.go"></div>`;
      const container = document.getElementById("container")!;
      container.scrollLeft = 120;
      container.scrollTop = 40;

      handleScrollDirectives(document.body); // first paint

      expect(container.scrollLeft).toBe(120);
      expect(container.scrollTop).toBe(40);
    });

    it("preserves scroll when watched attribute is unchanged across renders", () => {
      document.body.innerHTML = `<div id="container" lvt-fx:scroll="reset-on:data-path" data-path="a.go"></div>`;
      const container = document.getElementById("container")!;

      handleScrollDirectives(document.body);
      container.scrollLeft = 50;
      container.scrollTop = 25;

      for (let i = 0; i < 5; i++) handleScrollDirectives(document.body);

      expect(container.scrollLeft).toBe(50);
      expect(container.scrollTop).toBe(25);
    });

    it("treats attribute-absent → present as a change (and vice versa)", () => {
      document.body.innerHTML = `<div id="container" lvt-fx:scroll="reset-on:data-path"></div>`;
      const container = document.getElementById("container")!;

      handleScrollDirectives(document.body); // prior=null
      container.scrollLeft = 100;

      handleScrollDirectives(document.body); // still null → no reset
      expect(container.scrollLeft).toBe(100);

      container.setAttribute("data-path", "a.go"); // null → "a.go" is a change
      handleScrollDirectives(document.body);
      expect(container.scrollLeft).toBe(0);

      container.scrollLeft = 150;
      container.removeAttribute("data-path"); // "a.go" → null is a change
      handleScrollDirectives(document.body);
      expect(container.scrollLeft).toBe(0);
    });

    it("warns when no attribute name is supplied (reset-on:)", () => {
      document.body.innerHTML = `<div id="container" lvt-fx:scroll="reset-on:"></div>`;
      handleScrollDirectives(document.body);
      expect(console.warn).toHaveBeenCalledWith(
        `lvt-fx:scroll="reset-on:" requires an attribute name`
      );
    });

    it("tracks each element independently", () => {
      document.body.innerHTML = `
        <div id="a" lvt-fx:scroll="reset-on:data-path" data-path="x.go"></div>
        <div id="b" lvt-fx:scroll="reset-on:data-path" data-path="y.go"></div>
      `;
      const a = document.getElementById("a")!;
      const b = document.getElementById("b")!;

      handleScrollDirectives(document.body);
      a.scrollLeft = 10;
      b.scrollLeft = 20;

      a.setAttribute("data-path", "z.go"); // only a changes
      handleScrollDirectives(document.body);
      expect(a.scrollLeft).toBe(0);
      expect(b.scrollLeft).toBe(20);
    });
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

describe("handleAutoClickDirectives", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    jest.useFakeTimers();
    jest.spyOn(console, "warn").mockImplementation(() => {});
    __resetAnimatedElementsForTesting();
  });

  afterEach(() => {
    __resetAnimatedElementsForTesting();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("fires a click on the named descendant button after the delay", () => {
    document.body.innerHTML = `
      <div class="toast" lvt-fx:auto-click="5000:dismissBanner">
        Saved
        <button name="dismissBanner">×</button>
      </div>
    `;
    const btn = document.querySelector(
      'button[name="dismissBanner"]'
    )! as HTMLButtonElement;
    const clickSpy = jest.spyOn(btn, "click");

    handleAutoClickDirectives(document.body);
    expect(clickSpy).not.toHaveBeenCalled();

    jest.advanceTimersByTime(4999);
    expect(clickSpy).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("does not re-arm on subsequent renders with the same spec", () => {
    document.body.innerHTML = `
      <div id="toast" lvt-fx:auto-click="100:dismiss">
        <button name="dismiss">×</button>
      </div>
    `;
    const btn = document.querySelector(
      'button[name="dismiss"]'
    )! as HTMLButtonElement;
    const clickSpy = jest.spyOn(btn, "click");

    handleAutoClickDirectives(document.body);
    jest.advanceTimersByTime(50);
    handleAutoClickDirectives(document.body); // re-render mid-wait
    handleAutoClickDirectives(document.body);
    jest.advanceTimersByTime(50);

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("does not re-fire when element stays in DOM after timer fires", () => {
    // Race: timer fires (sends action via .click()), but the server
    // hasn't yet removed the toast element. A render pass landing
    // before the response would re-arm a fresh timer if the post-fire
    // map entry were cleared, causing a second .click() — silently
    // double-firing the action. Map entry must persist past fire.
    document.body.innerHTML = `
      <div id="toast" lvt-fx:auto-click="100:dismiss">
        <button name="dismiss">×</button>
      </div>
    `;
    const btn = document.querySelector(
      'button[name="dismiss"]'
    )! as HTMLButtonElement;
    const clickSpy = jest.spyOn(btn, "click");

    handleAutoClickDirectives(document.body);
    jest.advanceTimersByTime(100); // fires
    expect(clickSpy).toHaveBeenCalledTimes(1);

    // Server hasn't responded yet — re-render passes happen.
    handleAutoClickDirectives(document.body);
    handleAutoClickDirectives(document.body);
    jest.advanceTimersByTime(500);
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("cancels timer when the element is removed before firing", () => {
    document.body.innerHTML = `
      <div id="toast" lvt-fx:auto-click="100:dismiss">
        <button name="dismiss">×</button>
      </div>
    `;
    const toast = document.getElementById("toast")!;
    const btn = toast.querySelector(
      'button[name="dismiss"]'
    )! as HTMLButtonElement;
    const clickSpy = jest.spyOn(btn, "click");

    handleAutoClickDirectives(document.body);
    toast.remove();
    jest.advanceTimersByTime(500);

    expect(clickSpy).not.toHaveBeenCalled();
  });

  it("cancels timer when attribute is removed while element stays connected", () => {
    // Server resolves the toast's state (e.g. clears DoneWritten) without
    // removing the wrapper element. Without the attribute sweep, the
    // pending timer would still fire and click a button on a banner the
    // server already considers dismissed.
    document.body.innerHTML = `
      <div id="toast" lvt-fx:auto-click="100:dismiss">
        <button name="dismiss">×</button>
      </div>
    `;
    const toast = document.getElementById("toast")!;
    const btn = toast.querySelector(
      'button[name="dismiss"]'
    )! as HTMLButtonElement;
    const clickSpy = jest.spyOn(btn, "click");

    handleAutoClickDirectives(document.body);
    toast.removeAttribute("lvt-fx:auto-click"); // server cleared intent
    handleAutoClickDirectives(document.body); // next render's sweep
    jest.advanceTimersByTime(500);

    expect(clickSpy).not.toHaveBeenCalled();
  });

  it("re-arms with new spec when delay or button-name changes", () => {
    document.body.innerHTML = `
      <div id="toast" lvt-fx:auto-click="1000:dismiss">
        <button name="dismiss">×</button>
      </div>
    `;
    const toast = document.getElementById("toast")!;
    const btn = toast.querySelector(
      'button[name="dismiss"]'
    )! as HTMLButtonElement;
    const clickSpy = jest.spyOn(btn, "click");

    handleAutoClickDirectives(document.body);
    jest.advanceTimersByTime(500);

    toast.setAttribute("lvt-fx:auto-click", "200:dismiss");
    handleAutoClickDirectives(document.body);

    jest.advanceTimersByTime(199);
    expect(clickSpy).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("warns on malformed spec", () => {
    const malformed = [
      "just-text",       // no colon
      "abc:dismiss",     // non-numeric delay
      "100:",            // empty name
      "200abc:dismiss",  // trailing junk on delay — parseInt would lenient-accept 200
      "12.5:dismiss",    // float — \d+ rejects the dot
      "-100:dismiss",    // negative — \d+ rejects the sign
    ];
    for (const spec of malformed) {
      (console.warn as jest.Mock).mockClear();
      document.body.innerHTML = `<div lvt-fx:auto-click="${spec}"></div>`;
      handleAutoClickDirectives(document.body);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining("lvt-fx:auto-click expects")
      );
    }
  });

  it("ignores when no descendant matches the named selector", () => {
    document.body.innerHTML = `<div lvt-fx:auto-click="100:noSuchButton"></div>`;
    handleAutoClickDirectives(document.body);

    expect(() => jest.advanceTimersByTime(500)).not.toThrow();
  });

  it("accepts digit-prefixed button names", () => {
    // HTML permits names like "1-dismiss". The regex was tightened to
    // `^[\w-]+$` so this no longer fails.
    document.body.innerHTML = `
      <div lvt-fx:auto-click="100:1-dismiss">
        <button name="1-dismiss">×</button>
      </div>
    `;
    const btn = document.querySelector(
      'button[name="1-dismiss"]'
    )! as HTMLButtonElement;
    const clickSpy = jest.spyOn(btn, "click");

    handleAutoClickDirectives(document.body);
    jest.advanceTimersByTime(100);

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("teardownAutoClickTimers cancels all armed timers", () => {
    document.body.innerHTML = `
      <div id="t1" lvt-fx:auto-click="100:dismiss">
        <button name="dismiss">×</button>
      </div>
      <div id="t2" lvt-fx:auto-click="200:dismiss">
        <button name="dismiss">×</button>
      </div>
    `;
    const btns = Array.from(
      document.querySelectorAll('button[name="dismiss"]')
    ) as HTMLButtonElement[];
    const spies = btns.map((b) => jest.spyOn(b, "click"));

    handleAutoClickDirectives(document.body);
    teardownAutoClickTimers();
    jest.advanceTimersByTime(500);

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("does not match non-button elements with the same name", () => {
    // The selector is scoped to `button[name=...]` — a checkbox or text
    // input with the same name would otherwise get .click()ed with
    // surprising side effects (toggle / focus) unrelated to the
    // action-submission semantic the directive promises.
    document.body.innerHTML = `
      <div lvt-fx:auto-click="100:dismiss">
        <input type="checkbox" name="dismiss">
      </div>
    `;
    const cb = document.querySelector(
      'input[name="dismiss"]'
    )! as HTMLInputElement;
    const clickSpy = jest.spyOn(cb, "click");

    handleAutoClickDirectives(document.body);
    jest.advanceTimersByTime(500);

    expect(clickSpy).not.toHaveBeenCalled();
  });
});

describe("handleShadowRootHydration", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("attaches an open shadow root and moves template content into it", () => {
    document.body.innerHTML = `
      <div id="host">
        <template shadowrootmode="open"><span class="inner">hi</span></template>
      </div>
    `;
    const host = document.getElementById("host")!;

    handleShadowRootHydration(document.body);

    expect(host.shadowRoot).not.toBeNull();
    expect(host.shadowRoot!.querySelector(".inner")?.textContent).toBe("hi");
    // Template should be gone — leaving it would re-trigger the hook
    // on every subsequent render.
    expect(host.querySelector("template")).toBeNull();
  });

  it("honors shadowrootmode='closed'", () => {
    document.body.innerHTML = `
      <div id="host">
        <template shadowrootmode="closed"><span>x</span></template>
      </div>
    `;
    const host = document.getElementById("host")!;

    handleShadowRootHydration(document.body);

    // Closed shadow root: parent.shadowRoot stays null per spec, but
    // the template still gets consumed.
    expect(host.shadowRoot).toBeNull();
    expect(host.querySelector("template")).toBeNull();
  });

  it("is a no-op when there are no shadowroot templates", () => {
    document.body.innerHTML = `<div><p>nothing here</p></div>`;
    const before = document.body.innerHTML;

    handleShadowRootHydration(document.body);

    expect(document.body.innerHTML).toBe(before);
  });

  it("replaces existing shadow content on re-hydration in closed mode (WeakMap fallback)", () => {
    // parent.shadowRoot is null for closed roots by spec, so a re-render
    // would otherwise re-call attachShadow, throw NotSupportedError, and
    // silently drop the new content. The WeakMap side-channel locates
    // the prior root so replaceChildren actually updates it.
    document.body.innerHTML = `
      <div id="host">
        <template shadowrootmode="closed"><span class="round">1</span></template>
      </div>
    `;
    const host = document.getElementById("host")!;
    handleShadowRootHydration(document.body);
    expect(host.shadowRoot).toBeNull(); // closed — spec confirms

    // The directive's WeakMap holds the closed root; we can't observe
    // its content via host.shadowRoot, but we CAN verify (a) the
    // re-render path doesn't throw, (b) the template gets consumed,
    // and (c) the template's content left the light DOM — together,
    // strong evidence the content moved into the cached shadow root
    // rather than vanishing or staying parked as an inert template
    // (the exact failure mode pre-fix).
    host.innerHTML = `<template shadowrootmode="closed"><span class="round">2</span></template>`;
    expect(() => handleShadowRootHydration(document.body)).not.toThrow();
    expect(host.querySelector("template")).toBeNull();
    expect(host.children.length).toBe(0); // content lives in shadow, not light DOM
  });

  it("replaces existing shadow content on re-hydration (server re-render)", () => {
    document.body.innerHTML = `
      <div id="host">
        <template shadowrootmode="open"><span>first</span></template>
      </div>
    `;
    const host = document.getElementById("host")!;
    handleShadowRootHydration(document.body);
    expect(host.shadowRoot!.querySelector("span")?.textContent).toBe("first");

    // Simulate the server emitting a new template into the same host
    // after a morph (host kept, template re-inserted).
    host.innerHTML = `<template shadowrootmode="open"><span>second</span></template>`;
    handleShadowRootHydration(document.body);

    expect(host.shadowRoot!.querySelector("span")?.textContent).toBe("second");
    expect(host.querySelector("template")).toBeNull();
  });

  it("handles multiple sibling templates on one page", () => {
    document.body.innerHTML = `
      <div id="a"><template shadowrootmode="open"><i>A</i></template></div>
      <div id="b"><template shadowrootmode="open"><i>B</i></template></div>
      <div id="c"><template shadowrootmode="open"><i>C</i></template></div>
    `;

    handleShadowRootHydration(document.body);

    for (const [id, want] of [["a", "A"], ["b", "B"], ["c", "C"]] as const) {
      const host = document.getElementById(id)!;
      expect(host.shadowRoot?.querySelector("i")?.textContent).toBe(want);
    }
  });

  it("silently drops the template when the host can't accept a shadow root", () => {
    // Real-world hosts that can't accept a shadow root (void elements,
    // <input>, <textarea>, custom-element mode conflicts) make
    // attachShadow throw a DOMException. The hook must catch and
    // remove the template instead of leaving a re-trigger ticking on
    // every render. Drive the failure path via a stub on a regular
    // <div> so this test doesn't depend on jsdom's <input>-as-host
    // behaviour, which varies across versions.
    const host = document.createElement("div");
    host.id = "host";
    document.body.appendChild(host);
    const tpl = document.createElement("template");
    tpl.setAttribute("shadowrootmode", "open");
    host.appendChild(tpl);
    const orig = host.attachShadow.bind(host);
    host.attachShadow = () => {
      throw new DOMException(
        "Operation is not supported",
        "NotSupportedError"
      );
    };

    expect(() => handleShadowRootHydration(document.body)).not.toThrow();
    // Template must be removed even though attach failed.
    expect(host.querySelector("template")).toBeNull();
    expect(host.shadowRoot).toBeNull();

    host.attachShadow = orig;
    host.remove();
  });

  it("warns when attachShadow rejects the host (DOMException path)", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.createElement("div");
    host.id = "warn-host";
    document.body.appendChild(host);
    const tpl = document.createElement("template");
    tpl.setAttribute("shadowrootmode", "open");
    host.appendChild(tpl);
    host.attachShadow = () => {
      throw new DOMException(
        "Operation is not supported",
        "NotSupportedError"
      );
    };

    handleShadowRootHydration(document.body);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("attachShadow rejected"),
      host
    );
    warn.mockRestore();
    host.remove();
  });

  it("removes templates with an unrecognised shadowrootmode and warns", () => {
    // The HTML parser doesn't activate a `<template shadowrootmode>`
    // with an unknown mode value. The directive removes the template
    // outright (so the fast-path advertised in the docblock isn't
    // defeated by a persistent typo that the qsa keeps re-finding) and
    // logs a console.warn so authors actually see the mistake.
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    document.body.innerHTML = `
      <div id="host">
        <template shadowrootmode="opne"><span>typo</span></template>
      </div>
    `;
    const host = document.getElementById("host")!;
    handleShadowRootHydration(document.body);
    expect(host.shadowRoot).toBeNull();
    expect(host.querySelector("template")).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("invalid shadowrootmode"),
      expect.anything()
    );
    warn.mockRestore();
  });

  it("rethrows non-DOMException errors so real bugs surface", () => {
    document.body.innerHTML = `
      <div id="host"><template shadowrootmode="open"><span>x</span></template></div>
    `;
    const host = document.getElementById("host")!;
    host.attachShadow = () => {
      throw new Error("typo in options or runtime bug");
    };

    // A bare catch would have hidden this; the narrow guard surfaces it.
    expect(() => handleShadowRootHydration(document.body)).toThrow(
      "typo in options or runtime bug"
    );
  });

  it("idempotent re-run when no remaining templates is essentially free", () => {
    document.body.innerHTML = `<div id="host"></div>`;
    // First run: nothing to do.
    handleShadowRootHydration(document.body);
    // Second run on a clean tree: still nothing.
    handleShadowRootHydration(document.body);
    const host = document.getElementById("host")!;
    expect(host.shadowRoot).toBeNull();
  });

  it("forwards shadowrootdelegatesfocus / clonable / serializable to attachShadow", () => {
    // Use a spy because jsdom doesn't expose the options on the resulting
    // ShadowRoot in a stable way across versions — checking the call args
    // is what we actually want to assert ("the directive forwards
    // attributes faithfully to the platform call").
    document.body.innerHTML = `
      <div id="host">
        <template shadowrootmode="open" shadowrootdelegatesfocus shadowrootclonable shadowrootserializable>
          <span>focus me</span>
        </template>
      </div>
    `;
    const host = document.getElementById("host")!;
    const spy = jest.spyOn(host, "attachShadow");

    handleShadowRootHydration(document.body);

    expect(spy).toHaveBeenCalledWith({
      mode: "open",
      delegatesFocus: true,
      clonable: true,
      serializable: true,
    });
  });

  // Documented limitations — kept as it.skip so a future PR that
  // closes either gap can flip the skip and have an instant test.

  it("warns when shadowrootmode is changed on re-render (mode is one-shot)", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    document.body.innerHTML = `
      <div id="host">
        <template shadowrootmode="open"><span>first</span></template>
      </div>
    `;
    const host = document.getElementById("host")!;
    handleShadowRootHydration(document.body);
    // Server flips the mode on the next render — surfacing the mismatch
    // is the contract.
    host.innerHTML = `<template shadowrootmode="closed"><span>second</span></template>`;
    handleShadowRootHydration(document.body);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("shadowrootmode changed"),
      host
    );
    // The pre-existing open root persists (attachShadow can't be re-
    // called); content still updates inside it.
    expect(host.shadowRoot?.querySelector("span")?.textContent).toBe("second");
    warn.mockRestore();
  });

  it.skip("nested DSD inside another template is inert on first render", () => {
    // A `<template shadowrootmode>` nested inside another `<template>`
    // is in DocumentFragment land, which qsa doesn't descend into — the
    // inner template is never in the first qsa result, so it stays
    // inert from render zero. (The "on re-render" case is the same
    // mechanism: after the outer shadow attaches, the inner template
    // sits behind a shadow boundary, also out of qsa's reach.)
    document.body.innerHTML = `
      <div id="outer">
        <template shadowrootmode="open">
          <div id="inner">
            <template shadowrootmode="open"><span>nested</span></template>
          </div>
        </template>
      </div>
    `;
    handleShadowRootHydration(document.body);
    const outer = document.getElementById("outer")!;
    const inner = outer.shadowRoot!.getElementById("inner")!;
    expect(inner.shadowRoot).toBeNull();
    expect(inner.querySelector("template")).not.toBeNull();
  });

  it("defaults all extended options to false when attrs are absent", () => {
    document.body.innerHTML = `
      <div id="host">
        <template shadowrootmode="open"><span>x</span></template>
      </div>
    `;
    const host = document.getElementById("host")!;
    const spy = jest.spyOn(host, "attachShadow");

    handleShadowRootHydration(document.body);

    expect(spy).toHaveBeenCalledWith({
      mode: "open",
      delegatesFocus: false,
      clonable: false,
      serializable: false,
    });
  });
});

describe("handleAreaSelectDirectives", () => {
  // jsdom-friendly helper: configure the target element so it has a
  // non-trivial bounding rect (jsdom returns zeros by default) and a
  // positioned parent so the overlay has somewhere to land. Returns
  // [target, parent] for the assertions.
  function mountTarget(
    targetTag: "img" | "div",
    attrs: Record<string, string>,
    rect: { left: number; top: number; width: number; height: number }
  ): [HTMLElement, HTMLElement] {
    document.body.innerHTML = `
      <div id="parent" style="position:relative;">
        <${targetTag} id="target"></${targetTag}>
      </div>
    `;
    const target = document.getElementById("target") as HTMLElement;
    const parent = document.getElementById("parent") as HTMLElement;
    for (const [k, v] of Object.entries(attrs)) target.setAttribute(k, v);
    target.getBoundingClientRect = jest.fn(() => ({
      x: rect.left,
      y: rect.top,
      left: rect.left,
      top: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      width: rect.width,
      height: rect.height,
      toJSON: () => ({}),
    }));
    parent.getBoundingClientRect = jest.fn(() => ({
      x: rect.left,
      y: rect.top,
      left: rect.left,
      top: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      width: rect.width,
      height: rect.height,
      toJSON: () => ({}),
    }));
    // jsdom doesn't implement pointer-capture; stub so the directive's
    // try/catch around it doesn't matter, but the test still asserts
    // the contract.
    (target as any).setPointerCapture = jest.fn();
    (target as any).releasePointerCapture = jest.fn();
    return [target, parent];
  }

  function dispatchPointer(
    el: HTMLElement,
    type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel" | "lostpointercapture",
    clientX: number,
    clientY: number,
    pointerId = 1
  ): void {
    const e = new MouseEvent(type, { clientX, clientY, button: 0, bubbles: true });
    // PointerEvent isn't fully supported in jsdom but the directive
    // only reads pointerId / isPrimary / button / clientX / clientY.
    Object.defineProperty(e, "pointerId", { value: pointerId });
    Object.defineProperty(e, "isPrimary", { value: true });
    el.dispatchEvent(e);
  }

  beforeEach(() => {
    document.body.innerHTML = "";
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("dispatches the action with 0..1 fraction coords on pointerup", () => {
    const [target] = mountTarget(
      "img",
      { "lvt-fx:area-select": "selectImageArea" },
      { left: 100, top: 50, width: 200, height: 200 }
    );
    const send = jest.fn();
    handleAreaSelectDirectives(document.body, send);

    // Drag from (120, 80) → (220, 150) inside the rect.
    // x = (120 - 100) / 200 = 0.10
    // y = (80 - 50)   / 200 = 0.15
    // w = (220 - 120) / 200 = 0.50
    // h = (150 - 80)  / 200 = 0.35
    dispatchPointer(target, "pointerdown", 120, 80);
    dispatchPointer(target, "pointermove", 220, 150);
    dispatchPointer(target, "pointerup", 220, 150);

    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0];
    expect(msg.action).toBe("selectImageArea");
    expect(msg.data.x).toBeCloseTo(0.10, 5);
    expect(msg.data.y).toBeCloseTo(0.15, 5);
    expect(msg.data.w).toBeCloseTo(0.50, 5);
    expect(msg.data.h).toBeCloseTo(0.35, 5);
  });

  it("filters drags smaller than the min-fraction threshold", () => {
    const [target] = mountTarget(
      "img",
      { "lvt-fx:area-select": "selectImageArea" },
      { left: 0, top: 0, width: 1000, height: 1000 }
    );
    const send = jest.fn();
    handleAreaSelectDirectives(document.body, send);

    // Drag is 10×10 px on a 1000×1000 rect → 1% fraction in both dims.
    // 1% < MIN_AREA_FRACTION (2%) → must drop.
    dispatchPointer(target, "pointerdown", 100, 100);
    dispatchPointer(target, "pointermove", 110, 110);
    dispatchPointer(target, "pointerup", 110, 110);

    expect(send).not.toHaveBeenCalled();
    // Overlay should have been cleaned up after the failed drag.
    expect(document.querySelectorAll(".lvt-area-select-overlay").length).toBe(0);
  });

  it("paints an overlay during the drag and removes it on release", () => {
    const [, parent] = mountTarget(
      "img",
      { "lvt-fx:area-select": "selectImageArea" },
      { left: 0, top: 0, width: 200, height: 200 }
    );
    const target = parent.querySelector("img")! as HTMLElement;
    const send = jest.fn();
    handleAreaSelectDirectives(document.body, send);

    dispatchPointer(target, "pointerdown", 10, 10);
    expect(parent.querySelector(".lvt-area-select-overlay")).not.toBeNull();

    dispatchPointer(target, "pointermove", 60, 70);
    const overlay = parent.querySelector(".lvt-area-select-overlay") as HTMLDivElement;
    expect(overlay.style.width).toBe("50px");
    expect(overlay.style.height).toBe("60px");

    dispatchPointer(target, "pointerup", 60, 70);
    expect(parent.querySelector(".lvt-area-select-overlay")).toBeNull();
  });

  it("pointercancel removes the overlay and does NOT dispatch", () => {
    const [, parent] = mountTarget(
      "img",
      { "lvt-fx:area-select": "selectImageArea" },
      { left: 0, top: 0, width: 200, height: 200 }
    );
    const target = parent.querySelector("img")! as HTMLElement;
    const send = jest.fn();
    handleAreaSelectDirectives(document.body, send);

    dispatchPointer(target, "pointerdown", 10, 10);
    dispatchPointer(target, "pointermove", 60, 60);
    dispatchPointer(target, "pointercancel", 60, 60);

    expect(send).not.toHaveBeenCalled();
    expect(parent.querySelector(".lvt-area-select-overlay")).toBeNull();
  });

  it("is idempotent across renders for the same action", () => {
    const [target] = mountTarget(
      "img",
      { "lvt-fx:area-select": "selectImageArea" },
      { left: 0, top: 0, width: 200, height: 200 }
    );
    const send = jest.fn();

    handleAreaSelectDirectives(document.body, send);
    handleAreaSelectDirectives(document.body, send);
    handleAreaSelectDirectives(document.body, send);

    dispatchPointer(target, "pointerdown", 10, 10);
    dispatchPointer(target, "pointermove", 100, 100);
    dispatchPointer(target, "pointerup", 100, 100);

    // Listeners must NOT have been duplicated by repeated calls.
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("re-arms with new action when the attribute value changes", () => {
    const [target] = mountTarget(
      "img",
      { "lvt-fx:area-select": "first" },
      { left: 0, top: 0, width: 200, height: 200 }
    );
    const send = jest.fn();
    handleAreaSelectDirectives(document.body, send);
    target.setAttribute("lvt-fx:area-select", "second");
    handleAreaSelectDirectives(document.body, send);

    dispatchPointer(target, "pointerdown", 10, 10);
    dispatchPointer(target, "pointermove", 100, 100);
    dispatchPointer(target, "pointerup", 100, 100);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].action).toBe("second");
  });

  it("warns and skips when the attribute value is empty", () => {
    const warn = console.warn as jest.Mock;
    mountTarget(
      "img",
      { "lvt-fx:area-select": "" },
      { left: 0, top: 0, width: 200, height: 200 }
    );
    const send = jest.fn();
    handleAreaSelectDirectives(document.body, send);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("requires an action name")
    );
  });

  it("clamps coords to 0..1 when the drag escapes the element rect", () => {
    const [target] = mountTarget(
      "img",
      { "lvt-fx:area-select": "selectImageArea" },
      { left: 100, top: 100, width: 200, height: 200 }
    );
    const send = jest.fn();
    handleAreaSelectDirectives(document.body, send);

    // Drag starts inside but ends far below-right of the rect.
    dispatchPointer(target, "pointerdown", 150, 150);
    dispatchPointer(target, "pointerup", 10000, 10000);

    expect(send).toHaveBeenCalledTimes(1);
    const data = send.mock.calls[0][0].data as Record<string, number>;
    expect(data.x).toBeGreaterThanOrEqual(0);
    expect(data.x).toBeLessThanOrEqual(1);
    expect(data.x + data.w).toBeLessThanOrEqual(1);
    expect(data.y + data.h).toBeLessThanOrEqual(1);
  });

  it("fast-path returns when no matching elements", () => {
    document.body.innerHTML = `<div><p>nothing here</p></div>`;
    const send = jest.fn();
    // Should not throw, should not dispatch.
    expect(() => handleAreaSelectDirectives(document.body, send)).not.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it("removes the overlay when the host is detached mid-drag", () => {
    const [target, parent] = mountTarget(
      "img",
      { "lvt-fx:area-select": "selectImageArea" },
      { left: 0, top: 0, width: 200, height: 200 }
    );
    const send = jest.fn();
    handleAreaSelectDirectives(document.body, send);

    dispatchPointer(target, "pointerdown", 10, 10);
    expect(parent.querySelector(".lvt-area-select-overlay")).not.toBeNull();

    // Simulate a server diff replacing the host element.
    target.remove();

    // A late pointermove (jsdom dispatches to the detached element)
    // must clean up the overlay rather than leave it orphaned under
    // the parent.
    dispatchPointer(target, "pointermove", 60, 70);
    expect(parent.querySelector(".lvt-area-select-overlay")).toBeNull();
  });

  it("suppresses native <img> drag via dragstart preventDefault", () => {
    const [target] = mountTarget(
      "img",
      { "lvt-fx:area-select": "selectImageArea" },
      { left: 0, top: 0, width: 200, height: 200 }
    );
    handleAreaSelectDirectives(document.body, jest.fn());

    // Without the dragstart listener, Chromium would call default-
    // action (start a native image drag) and steal the gesture from
    // pointer events. The directive must call preventDefault on
    // dragstart so pointermove + pointerup keep arriving.
    const drag = new Event("dragstart", { bubbles: true, cancelable: true });
    target.dispatchEvent(drag);
    expect(drag.defaultPrevented).toBe(true);
  });

  it("positions overlay correctly when target is offset inside its parent", () => {
    // Parent at (0,0), target at (50, 25) — exercises the
    // border-box-to-padding-box offset math with a real gap.
    document.body.innerHTML = `
      <div id="parent" style="position:relative;">
        <img id="target" lvt-fx:area-select="selectImageArea">
      </div>
    `;
    const target = document.getElementById("target") as HTMLImageElement;
    const parent = document.getElementById("parent") as HTMLDivElement;
    target.getBoundingClientRect = jest.fn(() => ({
      x: 50, y: 25, left: 50, top: 25, right: 150, bottom: 125,
      width: 100, height: 100, toJSON: () => ({}),
    } as DOMRect));
    parent.getBoundingClientRect = jest.fn(() => ({
      x: 0, y: 0, left: 0, top: 0, right: 200, bottom: 200,
      width: 200, height: 200, toJSON: () => ({}),
    } as DOMRect));
    (target as any).setPointerCapture = jest.fn();
    (target as any).releasePointerCapture = jest.fn();
    handleAreaSelectDirectives(document.body, jest.fn());

    // Drag from (80, 50) → (120, 90) — inside the target's 100×100 rect.
    // Relative to the parent (and after subtracting clientLeft/clientTop=0
    // for a borderless parent), the overlay should sit at left=80, top=50.
    dispatchPointer(target, "pointerdown", 80, 50);
    dispatchPointer(target, "pointermove", 120, 90);
    const overlay = parent.querySelector(".lvt-area-select-overlay") as HTMLDivElement;
    expect(overlay).not.toBeNull();
    expect(overlay.style.left).toBe("80px");
    expect(overlay.style.top).toBe("50px");
    expect(overlay.style.width).toBe("40px");
    expect(overlay.style.height).toBe("40px");
  });

  it("does not preventDefault on pointerdown — clicks still bubble", () => {
    // The contract promises a small-rect drag (treated as a click)
    // still reaches the host's click handlers. Calling
    // preventDefault on pointerdown would suppress the compatibility
    // mouse events that fire click — so the directive must NOT do
    // that.
    const [target] = mountTarget(
      "img",
      { "lvt-fx:area-select": "selectImageArea" },
      { left: 0, top: 0, width: 200, height: 200 }
    );
    handleAreaSelectDirectives(document.body, jest.fn());

    const down = new MouseEvent("pointerdown", {
      clientX: 50, clientY: 50, button: 0, bubbles: true, cancelable: true,
    });
    Object.defineProperty(down, "pointerId", { value: 1 });
    Object.defineProperty(down, "isPrimary", { value: true });
    target.dispatchEvent(down);

    expect(down.defaultPrevented).toBe(false);
  });

  it("stale pointerleave listener does not survive into the next gesture", () => {
    // The bug Claude flagged: when setPointerCapture fails on drag N,
    // the directive registers a pointerleave fallback. If drag N
    // gets stuck (pointer never leaves so the fallback never fires
    // and no pointerup arrives), and the user starts drag N+1, the
    // re-entrancy guard finalizes drag N but the STALE pointerleave
    // listener from N would still be attached. If capture SUCCEEDS
    // on drag N+1 (no new pointerleave registered), the stale one
    // from N would still fire if the pointer ever leaves — and
    // incorrectly cancel drag N+1. finalize() must remove the
    // pointerleave listener so it can't outlive its own gesture.
    const [target] = mountTarget(
      "img",
      { "lvt-fx:area-select": "selectImageArea" },
      { left: 0, top: 0, width: 200, height: 200 }
    );
    // Capture FAILS only on the first call (drag N), succeeds after.
    let captureCalls = 0;
    (target as any).setPointerCapture = jest.fn(() => {
      captureCalls++;
      if (captureCalls === 1) {
        throw new DOMException("no capture", "InvalidStateError");
      }
    });
    const send = jest.fn();
    handleAreaSelectDirectives(document.body, send);

    // Drag N: pointerdown attaches the pointerleave fallback, but
    // user starts drag and never releases (simulates a "stuck"
    // drag). Do NOT pointerup.
    dispatchPointer(target, "pointerdown", 10, 10);
    dispatchPointer(target, "pointermove", 80, 80);

    // Drag N+1 starts. Re-entrancy guard finalizes drag N. WITHOUT
    // the fix, drag N's pointerleave listener stays attached.
    // Capture succeeds this time so no NEW pointerleave is attached.
    dispatchPointer(target, "pointerdown", 20, 20);
    dispatchPointer(target, "pointermove", 100, 100);

    // Fire pointerleave. With the fix, no pointerleave handler is
    // attached → no-op, drag N+1 continues. WITHOUT the fix, the
    // stale listener from N would call finalize and cancel.
    target.dispatchEvent(new MouseEvent("pointerleave", { bubbles: false }));
    dispatchPointer(target, "pointerup", 100, 100);

    // Drag N+1 should have dispatched normally — the stale listener
    // must NOT have cancelled it.
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("idempotent re-arm picks up the latest send callback (no stale closure)", () => {
    const [target] = mountTarget(
      "img",
      { "lvt-fx:area-select": "selectImageArea" },
      { left: 0, top: 0, width: 200, height: 200 }
    );
    const firstSend = jest.fn();
    const secondSend = jest.fn();

    handleAreaSelectDirectives(document.body, firstSend);
    // A subsequent render passes a different send (e.g. after a WS
    // reconnect rebuilt the transport). The idempotent path keeps
    // the listeners but MUST swap the captured send so the next
    // drag dispatches through the latest callback.
    handleAreaSelectDirectives(document.body, secondSend);

    dispatchPointer(target, "pointerdown", 10, 10);
    dispatchPointer(target, "pointermove", 100, 100);
    dispatchPointer(target, "pointerup", 100, 100);

    expect(firstSend).not.toHaveBeenCalled();
    expect(secondSend).toHaveBeenCalledTimes(1);
  });

  it("lostpointercapture cancels the drag without dispatching", () => {
    const [, parent] = mountTarget(
      "img",
      { "lvt-fx:area-select": "selectImageArea" },
      { left: 0, top: 0, width: 200, height: 200 }
    );
    const target = parent.querySelector("img")! as HTMLElement;
    const send = jest.fn();
    handleAreaSelectDirectives(document.body, send);

    dispatchPointer(target, "pointerdown", 10, 10);
    dispatchPointer(target, "pointermove", 80, 80);
    // Platform yanks capture (OS gesture, another setPointerCapture
    // call elsewhere). lostpointercapture should cancel like
    // pointercancel — overlay removed, no action dispatched.
    dispatchPointer(target, "lostpointercapture", 80, 80);

    expect(send).not.toHaveBeenCalled();
    expect(parent.querySelector(".lvt-area-select-overlay")).toBeNull();
  });

  it("cleans up armed elements whose attribute was removed by a server diff", () => {
    const [target] = mountTarget(
      "img",
      { "lvt-fx:area-select": "selectImageArea" },
      { left: 0, top: 0, width: 200, height: 200 }
    );
    const send = jest.fn();
    handleAreaSelectDirectives(document.body, send);

    // Server diff removes the attribute. The element stays in the DOM
    // (host alive, but no longer wants area-select). The next
    // handleAreaSelectDirectives pass MUST cancel the listeners — a
    // subsequent drag must not dispatch the old action.
    target.removeAttribute("lvt-fx:area-select");
    handleAreaSelectDirectives(document.body, send);

    dispatchPointer(target, "pointerdown", 10, 10);
    dispatchPointer(target, "pointermove", 100, 100);
    dispatchPointer(target, "pointerup", 100, 100);

    expect(send).not.toHaveBeenCalled();
  });

  it("recovers from a stuck drag on the next pointerdown (re-entrancy guard)", () => {
    const [target] = mountTarget(
      "img",
      { "lvt-fx:area-select": "selectImageArea" },
      { left: 0, top: 0, width: 200, height: 200 }
    );
    const send = jest.fn();
    handleAreaSelectDirectives(document.body, send);

    // First drag: pointerdown but no pointerup (simulates a captured
    // pointer that never released — what happens when capture silently
    // fails and pointer leaves the element).
    dispatchPointer(target, "pointerdown", 10, 10);
    dispatchPointer(target, "pointermove", 60, 60);
    // No pointerup. The drag is "stuck".

    // Second drag starts. Without the re-entrancy guard, the first
    // overlay would be orphaned. With the guard, the directive cancels
    // the stuck drag before starting the new one, and the new drag
    // completes normally.
    dispatchPointer(target, "pointerdown", 100, 100);
    dispatchPointer(target, "pointermove", 150, 150);
    dispatchPointer(target, "pointerup", 150, 150);

    expect(send).toHaveBeenCalledTimes(1);
    // The dispatched coords must come from the SECOND drag, not the
    // first. (Start=100, End=150 → x=0.5, w=0.25 on the 200-wide rect.)
    const data = send.mock.calls[0][0].data as Record<string, number>;
    expect(data.x).toBeCloseTo(0.50, 5);
    expect(data.w).toBeCloseTo(0.25, 5);
    // Exactly one overlay at most over the whole sequence (the second
    // drag's) — never two.
    expect(document.querySelectorAll(".lvt-area-select-overlay").length).toBe(0);
  });
});
