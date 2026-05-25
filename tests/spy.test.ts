import { setupSpy, teardownSpy } from "../dom/spy";

// Mock getBoundingClientRect so tests can position headings deterministically.
// jsdom returns all-zero rects by default, which would make every heading
// "above the trigger line" and every test ambiguous.
function setRect(el: Element, top: number): void {
  (el as any).getBoundingClientRect = () => ({
    top,
    bottom: top + 30,
    left: 0,
    right: 100,
    width: 100,
    height: 30,
    x: 0,
    y: top,
    toJSON: () => ({}),
  });
}

describe("setupSpy", () => {
  let rafCallbacks: FrameRequestCallback[];

  beforeEach(() => {
    document.body.replaceChildren();
    rafCallbacks = [];
    jest.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    // jsdom's innerHeight is 768 by default; pin it for deterministic
    // trigger-line math (25% of 768 = 192).
    Object.defineProperty(window, "innerHeight", { value: 768, configurable: true });
  });

  afterEach(() => {
    teardownSpy();
    jest.restoreAllMocks();
  });

  function flushRAF(): void {
    const cbs = rafCallbacks.splice(0);
    cbs.forEach((cb) => cb(performance.now()));
  }

  function buildFixture(): { article: HTMLElement; h1: HTMLElement; h2: HTMLElement; h3: HTMLElement; linkA: HTMLAnchorElement; linkB: HTMLAnchorElement; linkC: HTMLAnchorElement } {
    document.body.innerHTML = `
      <article lvt-spy="h1, h2, h3">
        <h1 id="intro">Intro</h1>
        <p>Body</p>
        <h2 id="usage">Usage</h2>
        <p>Body</p>
        <h3 id="config">Config</h3>
        <p>Body</p>
      </article>
      <nav>
        <a id="lA" href="#intro" lvt-spy-link>Intro</a>
        <a id="lB" href="#usage" lvt-spy-link>Usage</a>
        <a id="lC" href="#config" lvt-spy-link>Config</a>
      </nav>
    `;
    return {
      article: document.querySelector("article")!,
      h1: document.getElementById("intro")!,
      h2: document.getElementById("usage")!,
      h3: document.getElementById("config")!,
      linkA: document.getElementById("lA") as HTMLAnchorElement,
      linkB: document.getElementById("lB") as HTMLAnchorElement,
      linkC: document.getElementById("lC") as HTMLAnchorElement,
    };
  }

  it("highlights the topmost passed heading on initial paint", () => {
    const f = buildFixture();
    // h1 is above the trigger line; h2 and h3 are below.
    setRect(f.h1, 50);
    setRect(f.h2, 400);
    setRect(f.h3, 800);

    setupSpy(document.body);

    expect(f.linkA.classList.contains("lvt-active")).toBe(true);
    expect(f.linkB.classList.contains("lvt-active")).toBe(false);
    expect(f.linkC.classList.contains("lvt-active")).toBe(false);
  });

  it("advances active link as the user scrolls past each heading", () => {
    const f = buildFixture();
    setRect(f.h1, 50);
    setRect(f.h2, 400);
    setRect(f.h3, 800);
    setupSpy(document.body);

    // Simulate scroll: h2 has now passed the trigger line.
    setRect(f.h1, -200);
    setRect(f.h2, 100);
    setRect(f.h3, 500);
    window.dispatchEvent(new Event("scroll"));
    flushRAF();

    expect(f.linkA.classList.contains("lvt-active")).toBe(false);
    expect(f.linkB.classList.contains("lvt-active")).toBe(true);
    expect(f.linkC.classList.contains("lvt-active")).toBe(false);

    // Scroll further: h3 has passed too.
    setRect(f.h1, -700);
    setRect(f.h2, -400);
    setRect(f.h3, 100);
    window.dispatchEvent(new Event("scroll"));
    flushRAF();

    expect(f.linkA.classList.contains("lvt-active")).toBe(false);
    expect(f.linkB.classList.contains("lvt-active")).toBe(false);
    expect(f.linkC.classList.contains("lvt-active")).toBe(true);
  });

  it("highlights no link when scrolled above the first heading", () => {
    const f = buildFixture();
    // All headings below trigger line.
    setRect(f.h1, 500);
    setRect(f.h2, 800);
    setRect(f.h3, 1100);

    setupSpy(document.body);

    expect(f.linkA.classList.contains("lvt-active")).toBe(false);
    expect(f.linkB.classList.contains("lvt-active")).toBe(false);
    expect(f.linkC.classList.contains("lvt-active")).toBe(false);
  });

  it("optimistically activates a link on click", () => {
    const f = buildFixture();
    // Layout puts h1 as active.
    setRect(f.h1, 50);
    setRect(f.h2, 400);
    setRect(f.h3, 800);
    setupSpy(document.body);
    expect(f.linkA.classList.contains("lvt-active")).toBe(true);

    // User clicks the last link — h3 may never become topmost-visible if
    // the document ends shortly after it, so optimism is what keeps the UI
    // in sync with the user's intent.
    f.linkC.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(f.linkA.classList.contains("lvt-active")).toBe(false);
    expect(f.linkC.classList.contains("lvt-active")).toBe(true);
  });

  it("element-mode: spy directly on the element (empty attribute)", () => {
    document.body.innerHTML = `
      <h2 id="just-one" lvt-spy></h2>
      <a id="L" href="#just-one" lvt-spy-link>Just one</a>
    `;
    const h = document.getElementById("just-one")!;
    const link = document.getElementById("L")!;
    setRect(h, 50);

    setupSpy(document.body);

    expect(link.classList.contains("lvt-active")).toBe(true);
  });

  it("teardownSpy clears active class and removes scroll listener", () => {
    const f = buildFixture();
    setRect(f.h1, 50);
    setRect(f.h2, 400);
    setRect(f.h3, 800);
    setupSpy(document.body);
    expect(f.linkA.classList.contains("lvt-active")).toBe(true);

    teardownSpy();
    expect(f.linkA.classList.contains("lvt-active")).toBe(false);

    // After teardown, a scroll event should not re-pick. Move h2 above the
    // trigger and confirm linkB does NOT get activated.
    setRect(f.h2, 50);
    window.dispatchEvent(new Event("scroll"));
    flushRAF();
    expect(f.linkB.classList.contains("lvt-active")).toBe(false);
  });

  it("teardownSpy(wrapper) clears active class on links OUTSIDE the wrapper", () => {
    // Realistic layout: nav at the top of the document, content wrapper
    // below containing the spy targets. applyActive() queries links
    // globally, so the nav link picks up lvt-active even though it sits
    // outside the wrapper. A wrapper-scoped teardown must still scrub
    // those classes — otherwise disconnecting leaves the nav with a
    // stale highlight forever.
    document.body.innerHTML = `
      <nav id="topnav">
        <a id="navlink" href="#deep" lvt-spy-link>Deep</a>
      </nav>
      <div id="content">
        <article lvt-spy="h2">
          <h2 id="deep">Deep</h2>
        </article>
      </div>
    `;
    const navlink = document.getElementById("navlink")!;
    const target = document.getElementById("deep")!;
    const wrapper = document.getElementById("content")!;
    setRect(target, 50);

    setupSpy(document.body);
    expect(navlink.classList.contains("lvt-active")).toBe(true);

    // Wrapper-scoped teardown: the content wrapper is what disconnects.
    teardownSpy(wrapper);
    expect(navlink.classList.contains("lvt-active")).toBe(false);
  });

  it("swallows invalid lvt-spy selectors instead of aborting the scan", () => {
    // Two spy containers — the first has a typo that would throw
    // SyntaxError from querySelectorAll, the second is well-formed. The
    // bad container must not prevent the good one from initializing.
    document.body.innerHTML = `
      <article id="broken" lvt-spy="h1, h2,">
        <h1 id="x">X</h1>
      </article>
      <article id="ok" lvt-spy="h2">
        <h2 id="y">Y</h2>
      </article>
      <a id="L" href="#y" lvt-spy-link>Y</a>
    `;
    const link = document.getElementById("L")!;
    setRect(document.getElementById("y")!, 50);

    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    setupSpy(document.body);

    expect(warn).toHaveBeenCalled();
    expect(link.classList.contains("lvt-active")).toBe(true);
    warn.mockRestore();
  });

  it("teardownSpy(wrapper) removes the click handler when no bindings remain", () => {
    // The framework always calls teardownSpy(this.wrapperElement). If
    // the click handler is gated on (!wrapper) it survives every
    // teardown and clicks on stray [lvt-spy-link] elements continue to
    // re-apply lvt-active — with no scroll-driven reconciliation to
    // undo it. Gate on the binding count instead so the handler comes
    // off whenever the last binding is gone.
    const f = buildFixture();
    setRect(f.h1, 50);
    setRect(f.h2, 400);
    setRect(f.h3, 800);
    setupSpy(document.body);
    expect(f.linkA.classList.contains("lvt-active")).toBe(true);

    teardownSpy(f.article);
    expect(f.linkA.classList.contains("lvt-active")).toBe(false);

    // A click after teardown must NOT re-apply lvt-active. Before the
    // gate fix, the optimistic click handler survived teardown and
    // would put lvt-active back on the clicked link forever.
    f.linkC.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(f.linkC.classList.contains("lvt-active")).toBe(false);
  });

  it("readMarginPx rejects unsupported units and falls back to 25vh", () => {
    document.body.innerHTML = `
      <article id="container" lvt-spy="h2" style="--lvt-spy-margin: 2rem;">
        <h2 id="h1" style="position: relative; top: 100px;">H1</h2>
      </article>
      <a id="L" href="#h1" lvt-spy-link>H1</a>
    `;
    const h = document.getElementById("h1")!;
    const link = document.getElementById("L")!;
    // 25vh of 768 = 192. Bare px from 2rem (i.e. 2) would treat the
    // trigger line at 2px, so a heading at top=100 would be BELOW the
    // line and NOT active. Correct behaviour: fall back to 25vh = 192,
    // heading at top=100 is above → active.
    setRect(h, 100);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    setupSpy(document.body);

    expect(warn).toHaveBeenCalled();
    expect(link.classList.contains("lvt-active")).toBe(true);
    warn.mockRestore();
  });

  it("readMarginPx accepts explicit px unit", () => {
    document.body.innerHTML = `
      <article id="container" lvt-spy="h2" style="--lvt-spy-margin: 300px;">
        <h2 id="h2only">Above</h2>
      </article>
      <a id="L" href="#h2only" lvt-spy-link>Above</a>
    `;
    setRect(document.getElementById("h2only")!, 250);
    setupSpy(document.body);
    // 250 < 300 → active.
    expect(document.getElementById("L")!.classList.contains("lvt-active")).toBe(true);
  });

  it("re-attaches when target set changes (morphdom-style update)", () => {
    const f = buildFixture();
    setRect(f.h1, 50);
    setRect(f.h2, 400);
    setRect(f.h3, 800);
    setupSpy(document.body);
    expect(f.linkA.classList.contains("lvt-active")).toBe(true);

    // Simulate morphdom adding a new heading at the top.
    const h0 = document.createElement("h1");
    h0.id = "preamble";
    setRect(h0, 10);
    f.article.insertBefore(h0, f.article.firstChild);
    setRect(f.h1, 300); // pushed down by new heading

    // Add a corresponding link.
    const linkZ = document.createElement("a");
    linkZ.setAttribute("href", "#preamble");
    linkZ.setAttribute("lvt-spy-link", "");
    document.querySelector("nav")!.insertBefore(linkZ, f.linkA);

    setupSpy(document.body);
    expect(linkZ.classList.contains("lvt-active")).toBe(true);
    expect(f.linkA.classList.contains("lvt-active")).toBe(false);
  });
});
