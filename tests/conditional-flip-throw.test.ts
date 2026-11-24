/**
 * Paths where morphdom doesn't finish what the pre-pass planned, with morphdom
 * wrapped so a test can make it throw at, or skip, a chosen element:
 *
 * - a morph that throws partway leaves the page half-applied, and the next
 *   render must bring it back to exactly what the server sent;
 * - a skipped ancestor (an open popover, a focused element) means morphdom
 *   never reaches a placeholder inside it, which must not be left behind.
 *
 * It also pins the contract the pre-pass relies on: the client's discard hook
 * never vetoes a removal.
 */

let boomOn: string | null = null;
let skipOn: string | null = null;
let lastOpts: any = null;

jest.mock("morphdom", () => {
  const real = jest.requireActual("morphdom");
  const morph = real.default || real;
  const wrapped = (from: any, to: any, opts: any = {}) => {
    lastOpts = opts;
    return morph(from, to, {
      ...opts,
      onBeforeElUpdated: (f: Element, t: Element) => {
        if (boomOn && t.classList && t.classList.contains(boomOn)) throw new Error("boom");
        if (skipOn && t.classList && t.classList.contains(skipOn)) return false;
        return opts.onBeforeElUpdated ? opts.onBeforeElUpdated(f, t) : true;
      },
    });
  };
  return { __esModule: true, default: wrapped };
});

import { LiveTemplateClient } from "../livetemplate-client";

describe("a morph that throws partway", () => {
  let client: LiveTemplateClient;
  let wrapper: HTMLElement;

  beforeEach(() => {
    boomOn = null;
    skipOn = null;
    client = new LiveTemplateClient();
    document.body.replaceChildren();
    wrapper = document.createElement("div");
    wrapper.setAttribute("data-lvt-id", "test-throw");
    document.body.appendChild(wrapper);
  });

  const tree = {
    s: [
      `\n<span class="kbd"></span>\n`,
      `\n<div class="backdrop">`,
      `</div>\n<div class="layout">` +
        `<section data-key="lib"><button class="tab">Skills</button></section></div>\n`,
    ],
    0: "",
    1: "a",
  };
  const toast = { s: [`\n<div class="toast">working</div>\n`] };

  function fresh(state: any): string {
    const el = document.createElement("div");
    el.setAttribute("data-lvt-id", "fresh-" + Math.random());
    document.body.appendChild(el);
    new LiveTemplateClient().updateDOM(el, state);
    return el.innerHTML;
  }

  for (const [when, at] of [
    ["before the placeholder is filled", "toast"],
    ["after it is filled, at a later sibling", "layout"],
  ]) {
    it(`${when}: the next render reconciles the page`, () => {
      client.updateDOM(wrapper, tree);
      boomOn = at;
      expect(() => client.updateDOM(wrapper, { 0: toast })).toThrow("boom");
      boomOn = null;

      client.updateDOM(wrapper, { 1: "b" });
      expect(wrapper.innerHTML).toBe(fresh({ ...tree, 0: toast, 1: "b" }));
    });
  }

  it("a placeholder inside a skipped ancestor is taken out, and not mounted", () => {
    (window as any).__mounted = 0;
    client.updateDOM(wrapper, {
      s: [`\n<div class="pop">\n`, `\n<div class="x">X</div>\n<div class="y">Y</div>\n</div>\n`],
      0: "",
    });
    const pop = wrapper.querySelector(".pop")!;
    const before = pop.innerHTML;
    skipOn = "pop";
    client.updateDOM(wrapper, {
      0: { s: [`\n<div class="note" lvt-mounted="window.__mounted++">new</div>\n`] },
    });
    expect(wrapper.querySelector(".pop")).toBe(pop);
    expect(pop.innerHTML).toBe(before);
    expect((window as any).__mounted).toBe(0);
  });

  it("the client's discard hook never vetoes a removal (the pre-pass relies on it)", () => {
    client.updateDOM(wrapper, tree);
    client.updateDOM(wrapper, { 1: "c" });
    expect(lastOpts && typeof lastOpts.onBeforeNodeDiscarded).toBe("function");
    const plain = document.createElement("div");
    const hooked = document.createElement("div");
    hooked.setAttribute("lvt-destroyed", "void 0");
    expect(lastOpts.onBeforeNodeDiscarded(plain)).not.toBe(false);
    expect(lastOpts.onBeforeNodeDiscarded(hooked)).not.toBe(false);
  });
});
