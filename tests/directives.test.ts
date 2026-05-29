import {
  handleScrollDirectives,
  handleHighlightDirectives,
  handleAnimateDirectives,
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

    // The directive's WeakMap holds the closed root; we can't observe its
    // content via host.shadowRoot, but we CAN verify the re-render path
    // doesn't throw and doesn't drop the template, which is the exact
    // failure mode pre-fix.
    host.innerHTML = `<template shadowrootmode="closed"><span class="round">2</span></template>`;
    expect(() => handleShadowRootHydration(document.body)).not.toThrow();
    expect(host.querySelector("template")).toBeNull();
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

  it("skips templates with an unrecognised shadowrootmode (parser parity)", () => {
    // The HTML parser doesn't activate a `<template shadowrootmode>`
    // with an unknown mode value — it leaves the template inert. The
    // directive should match that behaviour rather than silently
    // coercing "opne" / "openn" / typos to "open".
    document.body.innerHTML = `
      <div id="host">
        <template shadowrootmode="opne"><span>typo</span></template>
      </div>
    `;
    const host = document.getElementById("host")!;
    handleShadowRootHydration(document.body);
    expect(host.shadowRoot).toBeNull();
    // The template is left in place so the author can spot the typo on
    // inspection rather than the content silently disappearing.
    expect(host.querySelector("template")).not.toBeNull();
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
