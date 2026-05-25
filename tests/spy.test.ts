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
