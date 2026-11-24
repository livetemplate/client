/**
 * A conditional element appearing or going away must not rebuild the unkeyed
 * siblings after it.
 *
 * morphdom pairs unkeyed sibling elements by position (tag name only). So when
 * an `{{if}}` puts a <div> in front of two unkeyed <div>s, morphdom used to
 * morph the first sibling into the new element and the second into the first,
 * then build a fresh copy of the second. Its handleNodeAdded moves keyed
 * descendants into that copy with replaceChild, detaching them, which loses an
 * in-flight click and reloads an iframe. Seen in prereview: a "working" toast
 * appearing rebuilt the whole layout and lost clicks on the Library's tabs.
 */

import { LiveTemplateClient } from "../livetemplate-client";

describe("a conditional flip keeps its siblings", () => {
  let client: LiveTemplateClient;
  let wrapper: HTMLElement;

  beforeEach(() => {
    client = new LiveTemplateClient();
    document.body.replaceChildren();
    wrapper = document.createElement("div");
    wrapper.setAttribute("data-lvt-id", "test-flip");
    document.body.appendChild(wrapper);
  });

  // The page: a conditional slot, then an unkeyed backdrop and layout; the
  // layout holds a keyed section with a button.
  const page = (slot: unknown) => ({
    s: [
      `<span class="kbd"></span>`,
      `<div class="backdrop"></div><div class="layout"><main class="viewer"><section class="library" data-key="library"><button class="tab">Skills</button></section></main></div>`,
    ],
    0: slot,
  });
  const toast = { s: [`<div class="toast">working</div>`] };

  function nodes() {
    return {
      backdrop: wrapper.querySelector(".backdrop"),
      layout: wrapper.querySelector(".layout"),
      main: wrapper.querySelector("main"),
      section: wrapper.querySelector("section.library"),
      tab: wrapper.querySelector("button.tab"),
    };
  }

  // detached lists every element the update removed from its parent, even if it
  // was put back (a move).
  function watch() {
    const mo = new MutationObserver(() => {});
    mo.observe(wrapper, { childList: true, subtree: true });
    return () => {
      const out: string[] = [];
      for (const r of mo.takeRecords()) {
        r.removedNodes.forEach((n) => {
          if (n.nodeType === 1) out.push((n as Element).className || (n as Element).tagName);
        });
      }
      mo.disconnect();
      return out;
    };
  }

  it("an element appearing before them keeps every sibling and detaches nothing", () => {
    client.updateDOM(wrapper, page(""));
    const before = nodes();
    const detached = watch();

    client.updateDOM(wrapper, { 0: toast });

    expect(wrapper.querySelector(".toast")?.textContent).toBe("working");
    const after = nodes();
    expect(after.backdrop).toBe(before.backdrop);
    expect(after.layout).toBe(before.layout);
    expect(after.main).toBe(before.main);
    expect(after.section).toBe(before.section);
    expect(after.tab).toBe(before.tab);
    expect(detached()).toEqual([]);
  });

  it("the element going away keeps every sibling too", () => {
    client.updateDOM(wrapper, page(toast));
    const before = nodes();
    const detached = watch();

    client.updateDOM(wrapper, { 0: "" });

    expect(wrapper.querySelector(".toast")).toBeNull();
    const after = nodes();
    expect(after.backdrop).toBe(before.backdrop);
    expect(after.layout).toBe(before.layout);
    expect(after.section).toBe(before.section);
    // The departing toast may be moved aside before it is removed; no one else.
    expect(detached().filter((c) => c !== "toast")).toEqual([]);
  });

  it("holds at depth, inside a keyed parent", () => {
    client.updateDOM(wrapper, {
      s: [`<div data-key="outer">`, `<div class="a"><input class="field"></div><div class="b">B</div></div>`],
      0: "",
    });
    const a = wrapper.querySelector(".a");
    const field = wrapper.querySelector("input.field");
    const b = wrapper.querySelector(".b");
    const detached = watch();

    client.updateDOM(wrapper, { 0: { s: [`<div class="note">saved</div>`] } });

    expect(wrapper.querySelector(".note")).not.toBeNull();
    expect(wrapper.querySelector(".a")).toBe(a);
    expect(wrapper.querySelector("input.field")).toBe(field);
    expect(wrapper.querySelector(".b")).toBe(b);
    expect(detached()).toEqual([]);
  });

  it("siblings that look alike fall back to pairing by position, as before", () => {
    client.updateDOM(wrapper, {
      s: [`<ul>`, `<li class="item">one</li><li class="item">two</li></ul>`],
      0: "",
    });
    client.updateDOM(wrapper, { 0: { s: [`<li class="item">zero</li>`] } });
    expect([...wrapper.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["zero", "one", "two"]);
  });

  it("leaves nothing behind: the page matches a fresh render", () => {
    client.updateDOM(wrapper, page(""));
    client.updateDOM(wrapper, { 0: toast });
    client.updateDOM(wrapper, { 0: "" });

    const fresh = document.createElement("div");
    fresh.setAttribute("data-lvt-id", "test-fresh");
    document.body.appendChild(fresh);
    new LiveTemplateClient().updateDOM(fresh, page(""));
    expect(wrapper.innerHTML).toBe(fresh.innerHTML);
  });

  it("keeps a sibling whose modifier class changes in the same update", () => {
    const layout = (cls: unknown) => ({
      s: [`<span class="kbd"></span>`, `<div class="backdrop"></div><div class="layout`, `"><section data-key="lib">x</section></div>`],
      0: "",
      1: cls,
    });
    client.updateDOM(wrapper, layout(""));
    const before = wrapper.querySelector(".layout");
    const detached = watch();

    client.updateDOM(wrapper, { 0: toast, 1: " focus-mode" });

    const after = wrapper.querySelector(".layout");
    expect(after).toBe(before);
    expect(after!.className).toBe("layout focus-mode");
    expect(detached()).toEqual([]);
  });

  it("gives a new script no placeholder, so it stays inert as before", () => {
    (window as any).__ran = 0;
    client.updateDOM(wrapper, page(""));
    client.updateDOM(wrapper, { 0: { s: [`<script>window.__ran = 1</script>`] } });
    expect((window as any).__ran).toBe(0);
  });

  it("builds an SVG placeholder in the SVG namespace", () => {
    client.updateDOM(wrapper, {
      s: [`<svg viewBox="0 0 10 10">`, `<rect class="frame" width="10" height="10"></rect></svg>`],
      0: "",
    });
    const frame = wrapper.querySelector("rect.frame");
    client.updateDOM(wrapper, { 0: { s: [`<circle class="dot" r="2"></circle>`] } });
    const dot = wrapper.querySelector("circle.dot")!;
    expect(dot.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(wrapper.querySelector("rect.frame")).toBe(frame);
  });

  it("a keyed node moving into a new container keeps its identity", () => {
    // The keyed section lives in .layout, then moves into a wrapper that
    // appears before the backdrop. It must be the same node afterwards.
    client.updateDOM(wrapper, {
      s: [`<span class="kbd"></span>`, `<div class="backdrop"></div><div class="layout">`, `</div>`],
      0: "",
      1: { s: [`<section data-key="stage"><input class="field"></section>`] },
    });
    const stage = wrapper.querySelector('section[data-key="stage"]');
    client.updateDOM(wrapper, {
      0: { s: [`<div class="wrap"><section data-key="stage"><input class="field"></section></div>`] },
      1: "",
    });
    const moved = wrapper.querySelector('.wrap > section[data-key="stage"]');
    expect(moved).toBe(stage);
  });

  it("a new element in front of paired siblings is mounted, not updated", () => {
    (window as any).__mounted = 0;
    (window as any).__updated = 0;
    client.updateDOM(wrapper, page(""));
    client.updateDOM(wrapper, {
      0: { s: [`<div class="toast" lvt-mounted="window.__mounted++" lvt-updated="window.__updated++">working</div>`] },
    });
    expect((window as any).__mounted).toBe(1);
    expect((window as any).__updated).toBe(0);
  });

  it("keeps a sibling when one element appears as another goes", () => {
    // [a, b, c] becomes [new, a, c]: the same number of <div>s, so the tags
    // alone line up, but pairing by position would morph a into new.
    client.updateDOM(wrapper, {
      s: [``, `<div class="a"><input class="field"></div>`, `<div class="c">C</div>`],
      0: "",
      1: { s: [`<div class="b">B</div>`] },
    });
    const a = wrapper.querySelector(".a");
    const field = wrapper.querySelector("input.field");
    const c = wrapper.querySelector(".c");
    const detached = watch();
    client.updateDOM(wrapper, { 0: { s: [`<div class="new">N</div>`] }, 1: "" });
    expect([...wrapper.children].map((e) => e.className)).toEqual(["new", "a", "c"]);
    expect(wrapper.querySelector(".a")).toBe(a);
    expect(wrapper.querySelector("input.field")).toBe(field);
    expect(wrapper.querySelector(".c")).toBe(c);
    expect(detached()).not.toContain("a");
  });

  it("a checked checkbox appearing before paired siblings is checked, as before", () => {
    client.updateDOM(wrapper, page(""));
    client.updateDOM(wrapper, { 0: { s: [`<input class="opt" type="checkbox" checked>`] } });
    const box = wrapper.querySelector("input.opt") as HTMLInputElement;
    expect(box.checked).toBe(true);
  });

  it("a custom element appearing before paired siblings connects whole, as before", () => {
    const seen: string[] = [];
    if (!customElements.get("x-badge")) {
      customElements.define(
        "x-badge",
        class extends HTMLElement {
          connectedCallback() {
            seen.push(this.getAttribute("label") || "(none)");
          }
        }
      );
    }
    client.updateDOM(wrapper, page(""));
    client.updateDOM(wrapper, { 0: { s: [`<x-badge label="new"></x-badge>`] } });
    expect(seen).toEqual(["new"]);
  });

  it("treats an empty data-key as no key", () => {
    client.updateDOM(wrapper, {
      s: [`<span class="kbd"></span>`, `<div class="layout" data-key=""><input class="field"></div>`],
      0: "",
    });
    const layout = wrapper.querySelector(".layout");
    client.updateDOM(wrapper, { 0: toast });
    expect(wrapper.querySelector(".layout")).toBe(layout);
  });

  // Real templates put whitespace between elements, and morphdom pairs text
  // nodes by position too: an element appearing splits one text node in two,
  // and one going away leaves two behind.
  describe("with whitespace between siblings, as real templates have", () => {
    const spaced = (slot: unknown) => ({
      s: [
        `\n<span class="kbd"></span>\n`,
        `\n<div class="backdrop"></div>\n<div class="layout"><main class="viewer">\n<section class="library" data-key="library"><button class="tab">Skills</button></section>\n</main></div>\n<div class="help"></div>\n`,
      ],
      0: slot,
    });
    const spacedToast = { s: [`\n<div class="toast">working</div>\n`] };

    it("an element appearing keeps every sibling", () => {
      client.updateDOM(wrapper, spaced(""));
      const before = nodes();
      const detached = watch();
      client.updateDOM(wrapper, { 0: spacedToast });
      expect(wrapper.querySelector(".toast")).not.toBeNull();
      expect(nodes()).toEqual(before);
      expect(nodes().layout).toBe(before.layout);
      expect(detached().filter((c) => c !== "")).toEqual([]);
    });

    it("an element going away keeps every sibling", () => {
      client.updateDOM(wrapper, spaced(spacedToast));
      const before = nodes();
      const detached = watch();
      client.updateDOM(wrapper, { 0: "" });
      expect(wrapper.querySelector(".toast")).toBeNull();
      expect(nodes().layout).toBe(before.layout);
      expect(nodes().backdrop).toBe(before.backdrop);
      // The departing toast may be moved aside before it is removed; no one else.
    expect(detached().filter((c) => c !== "toast")).toEqual([]);
    });

    it("appearing and going repeatedly leaves the page as a fresh render", () => {
      client.updateDOM(wrapper, spaced(""));
      for (const slot of [spacedToast, "", spacedToast, ""]) client.updateDOM(wrapper, { 0: slot });
      const fresh = document.createElement("div");
      fresh.setAttribute("data-lvt-id", "test-fresh2");
      document.body.appendChild(fresh);
      new LiveTemplateClient().updateDOM(fresh, spaced(""));
      expect(wrapper.innerHTML).toBe(fresh.innerHTML);
    });
  });
});
