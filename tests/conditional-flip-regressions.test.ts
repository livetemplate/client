/**
 * Regressions found by the audit of #176 (reviewers A, B and C), each one
 * passing on main (v0.27.0). A sibling-alignment change may only make updates
 * better than main, never worse, so each of these must keep passing.
 */

import { LiveTemplateClient } from "../livetemplate-client";

describe("sibling alignment: no worse than main", () => {
  let client: LiveTemplateClient;
  let wrapper: HTMLElement;

  beforeEach(() => {
    (window as any).__log = [];
    client = new LiveTemplateClient();
    document.body.replaceChildren();
    wrapper = document.createElement("div");
    wrapper.setAttribute("data-lvt-id", "regressions");
    document.body.appendChild(wrapper);
  });

  const fresh = (tree: any): string => {
    const el = document.createElement("div");
    el.setAttribute("data-lvt-id", "fresh-" + Math.random());
    document.body.appendChild(el);
    new LiveTemplateClient().updateDOM(el, tree);
    const html = el.innerHTML;
    el.remove();
    return html;
  };

  // The page after tree then update matches a fresh render of the final state.
  const run = (tree: any, update: any) => {
    client.updateDOM(wrapper, tree);
    client.updateDOM(wrapper, update);
    expect(wrapper.innerHTML).toBe(fresh({ ...tree, ...update }));
  };

  describe("order: an element leaving early while one of its tag arrives later", () => {
    it("divs (B F1a)", () => {
      run({ s: [``, `\n<div class="b">B</div>\n`, `\n`], 0: { s: [`<div class="a">A</div>`] }, 1: "" },
        { 0: "", 1: { s: [`<div class="c">C</div>`] } });
    });
    it("list items (B F1c)", () => {
      run({ s: [`<ul>\n`, `\n<li class="b">B</li>\n`, `\n</ul>`], 0: { s: [`<li class="a">A</li>`] }, 1: "" },
        { 0: "", 1: { s: [`<li class="c">C</li>`] } });
    });
    it("SVG children (B F1d)", () => {
      run({ s: [`<svg>`, `<rect class="r"></rect>`, `</svg>`], 0: { s: [`<circle class="c1"></circle>`] }, 1: "" },
        { 0: "", 1: { s: [`<circle class="c2"></circle>`] } });
    });
    it("buttons in the middle (B F1e)", () => {
      run({ s: [``, `<div class="p">P</div>`, `<div class="q">Q</div>`], 0: { s: [`<button class="x">X</button>`] }, 1: "" },
        { 0: "", 1: { s: [`<button class="y">Y</button>`] } });
    });
    it("a checkbox (A1)", () => {
      run({ s: ["", `<div class="body">B</div>`, ""], 0: `<input type="checkbox" class="old">`, 1: "" },
        { 0: "", 1: `<input type="checkbox" class="new">` });
    });
    it("a div with hooks (A1b)", () => {
      run({ s: ["", `<div class="body">B</div>`, ""], 0: `<div class="gone">G</div>`, 1: "" },
        { 0: "", 1: `<div class="new">N</div>` });
    });
    it("a different first class in the trailing gap (C R1)", () => {
      run({ s: ["", ""], 0: { s: [`<ul class="item"></ul><div></div>`] } }, { 0: { s: [`<div></div><ul></ul>`] } });
    });
    it("a non-placeable tag in the trailing gap (C R2)", () => {
      run({ s: ["", "<div></div>", ""], 0: { s: ["<button></button>"] }, 1: "" },
        { 0: "", 1: { s: [`<button class="u2"></button>`] } });
    });
  });

  describe("state classes first: tabs and rows keep their nodes, content and focus", () => {
    it("a Tailwind-style tab bar (B F1f)", () => {
      run({
        s: [`<nav>\n<button class="`, ` px-2">One</button>\n<button class="`, ` px-2">Two</button>\n<button class="`, ` px-2">Three</button>\n</nav>`],
        0: "bg-white", 1: "bg-blue", 2: "bg-white",
      }, { 0: "bg-blue", 1: "bg-white" });
    });

    it("selected row moves; classes and typed values stay (B F1g)", () => {
      client.updateDOM(wrapper, {
        s: [`<ul>\n<li class="`, ` row"><input></li>\n<li class="`, ` row"><input></li>\n<li class="`, ` row"><input></li>\n</ul>`],
        0: "plain", 1: "selected", 2: "plain",
      });
      const inputs = [...wrapper.querySelectorAll("input")];
      ["first", "second", "third"].forEach((v, i) => (inputs[i].value = v));
      client.updateDOM(wrapper, { 0: "selected", 1: "plain" });
      expect([...wrapper.querySelectorAll("li")].map((li) => li.className)).toEqual(["selected row", "plain row", "plain row"]);
      expect([...wrapper.querySelectorAll("input")].map((i) => i.value)).toEqual(["first", "second", "third"]);
    });

    it("two buttons toggle; nothing detached, focus kept (B F2)", () => {
      client.updateDOM(wrapper, {
        s: [`<nav>\n<button class="`, ` px-2">One</button>\n<button class="`, ` px-2">Two</button>\n</nav>`],
        0: "bg-white", 1: "bg-blue",
      });
      const [one, two] = [...wrapper.querySelectorAll("button")];
      one.focus();
      const mo = new MutationObserver(() => {});
      mo.observe(wrapper, { childList: true, subtree: true });
      client.updateDOM(wrapper, { 0: "bg-blue", 1: "bg-white" });
      const removed = mo.takeRecords().flatMap((r) => [...r.removedNodes]).filter((n) => n.nodeType === 1);
      mo.disconnect();
      const after = [...wrapper.querySelectorAll("button")];
      expect({ detached: removed.length, one: after[0] === one, two: after[1] === two, focus: document.activeElement === one })
        .toEqual({ detached: 0, one: true, two: true, focus: true });
    });

    it("the active class moves between unclassed tabs (A2)", () => {
      client.updateDOM(wrapper, {
        s: [`<button class="`, `">One</button><button class="`, `">Two</button><button class="`, `">Three</button>`],
        0: "active", 1: "", 2: "",
      });
      const before = [...wrapper.querySelectorAll("button")];
      before[1].focus();
      client.updateDOM(wrapper, { 0: "", 1: "active" });
      const after = [...wrapper.querySelectorAll("button")];
      expect({
        order: after.map((b) => b.textContent),
        same: after.map((b, i) => b === before[i]),
        focus: document.activeElement === before[1],
      }).toEqual({ order: ["One", "Two", "Three"], same: [true, true, true], focus: true });
    });

    it("two tabs swap a lone active class and keep their own content (A2b)", () => {
      client.updateDOM(wrapper, { s: [`<button class="`, `">One</button><button class="`, `">Two</button>`], 0: "active", 1: "" });
      const before = [...wrapper.querySelectorAll("button")];
      client.updateDOM(wrapper, { 0: "", 1: "active" });
      expect(before.map((b) => b.textContent)).toEqual(["One", "Two"]);
    });
  });

  describe("new elements are not lost", () => {
    it("an empty element before a sibling (A6)", () => {
      run({ s: [`<div class="p">`, `<i class="x">X</i></div>`], 0: "" }, { 0: { s: [`<span></span>`] } });
    });
    it("an empty cell before a sibling cell (A6b)", () => {
      run({ s: [`<table><tbody><tr class="r">`, `<td class="x">X</td></tr></tbody></table>`], 0: "" }, { 0: { s: [`<td></td>`] } });
    });
  });

  describe("comments", () => {
    it("an empty comment in an inserted gap (B F3)", () => {
      run({ s: [``, `<div class="b">B</div>`], 0: "" }, { 0: { s: [`<div class="n">N</div><!---->`] } });
    });
    it("an empty comment the server sends (A5)", () => {
      run({ s: ["", `<div class="x">X</div><div class="y">Y</div>`], 0: `<p class="gone">g</p>` }, { 0: { s: [`<!---->`] } });
    });
  });

  describe("a focused select is left alone (A3)", () => {
    it("keeps its options and the user's selection", () => {
      client.updateDOM(wrapper, {
        s: [`<select class="pick">`, `<option class="c" value="c">C</option></select>`],
        0: `<option class="a" value="a">A</option><option class="b" value="b">B</option>`,
      });
      const sel = wrapper.querySelector("select") as HTMLSelectElement;
      sel.focus();
      sel.value = "a";
      const before = sel.innerHTML;
      client.updateDOM(wrapper, { 0: "" });
      expect({ options: sel.innerHTML, value: sel.value, focused: document.activeElement === sel })
        .toEqual({ options: before, value: "a", focused: true });
    });
  });

  describe("keys repeated under different parents (C R3, R6)", () => {
    it("an element doesn't gain a copy of a keyed child", () => {
      run({ s: ["", `<div><div data-key="k0"></div></div> <div data-key="k0"></div>`], 0: "" }, { 0: { s: [" <div></div>"] } });
    });
    it("the update doesn't throw", () => {
      client.updateDOM(wrapper, { s: ["", "<span></span>"], 0: "" });
      expect(() => client.updateDOM(wrapper, { 0: { s: [`<ul><li data-key="k1"></li> </ul><li data-key="k1"></li>`] } })).not.toThrow();
    });
  });

  describe("lvt-ignore (C R4)", () => {
    it("a new element is not paired with a live lvt-ignore element", () => {
      run({ s: ["", `<span></span><span lvt-ignore></span>`], 0: "" }, { 0: { s: ["<span></span>x"] } });
    });
  });
});
