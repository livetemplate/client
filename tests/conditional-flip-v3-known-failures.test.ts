// Known failures of this design (#176 is parked as a draft): six cases where
// sibling alignment v3 is worse than main (v0.27.0), from the final
// adversarial review, 2026-11-25. Each fails on this branch and passes on
// main, so the suite is skipped here. A next attempt must pass these, as well
// as tests/conditional-flip-regressions.test.ts and the property test.
import { LiveTemplateClient } from "../livetemplate-client";
import { executeAction } from "../dom/reactive-attributes";

describe.skip("v3 known failures (each passes on main)", () => {
  let client: LiveTemplateClient;
  let wrapper: HTMLElement;
  const log = () => (window as any).__log as string[];

  beforeEach(() => {
    (window as any).__log = [];
    client = new LiveTemplateClient();
    document.body.replaceChildren();
    wrapper = document.createElement("div");
    wrapper.setAttribute("data-lvt-id", "v3");
    document.body.appendChild(wrapper);
  });

  // F1: a placeholder's lvt-mounted ran before its children existed.
  it("V1: lvt-mounted on an element appended at the end sees its children", () => {
    client.updateDOM(wrapper, { s: [`<span class="b">B</span>`, ``], 0: "" });
    client.updateDOM(wrapper, {
      0: { s: [`<div class="new" lvt-mounted="window.__log.push(this.children.length + ':' + this.textContent)"><b>hi</b></div>`] },
    });
    expect(log()).toEqual(["1:hi"]);
  });

  it("V1b: content an lvt-mounted hook adds to its element survives", () => {
    client.updateDOM(wrapper, { s: [`<span class="b">B</span>`, ``], 0: "" });
    client.updateDOM(wrapper, {
      0: { s: [`<div class="new" lvt-mounted="this.insertAdjacentHTML('beforeend', '<i class=added>x</i>')"><b>hi</b></div>`] },
    });
    expect(wrapper.querySelector("div.new")!.innerHTML).toBe(`<b>hi</b><i class="added">x</i>`);
  });

  // F2: in the range applier's single-row morph the incoming keys are
  // invisible (tempWrapper holds a skip placeholder there).
  it("V2: range-applier u op: a keyed element that moves within the row gets no lvt-destroyed", () => {
    const B = `<b data-key="kb" lvt-destroyed="window.__log.push('destroyed kb')">B</b>`;
    client.updateDOM(wrapper, {
      s: [`<div class="list">`, `</div>`],
      0: {
        d: [{ _k: "r1", 0: "r1", 1: `<p class="x">${B}</p>`, 2: "" }],
        s: [`<div data-key="`, `"><p class="a">A</p>`, `<p class="z">`, `Z</p></div>`],
        m: { idKey: "0" },
      },
    });
    const b = wrapper.querySelector('[data-key="kb"]');
    client.updateDOM(wrapper, { 0: [["u", "r1", { 1: "", 2: B }]] } as any);
    expect({
      html: wrapper.querySelector('[data-key="r1"]')!.innerHTML,
      same: wrapper.querySelector('[data-key="kb"]') === b,
      log: log(),
    }).toEqual({ html: `<p class="a">A</p><p class="z">${B}Z</p>`, same: true, log: [] });
  });

  // F3: the live-key snapshot was read lazily, after morphdom had detached a node.
  const P = `<p data-key="k" lvt-destroyed="window.__log.push('destroyed k')">K</p>`;
  it("V3: a keyed element moving out of a removed wrapper into a new element keeps its node", () => {
    client.updateDOM(wrapper, {
      s: [`<div class="one">`, `</div><div class="two">`, `<span class="s">S</span></div>`],
      0: `<section>${P}</section>`,
      1: "",
    });
    const p = wrapper.querySelector('[data-key="k"]');
    client.updateDOM(wrapper, { 0: "", 1: P });
    const after = wrapper.querySelector('[data-key="k"]');
    expect({ same: after === p, oldConnected: p!.isConnected, destroyed: log().includes("destroyed k") })
      .toEqual({ same: true, oldConnected: true, destroyed: false });
  });

  // F4/F5: a class change on the first item broke the front trim, so the back
  // trim removed the wrong item.
  it("V4: a client-toggled class on an unclassed item survives a later sibling's removal", () => {
    client.updateDOM(wrapper, {
      s: [`<ul><li lvt-el:toggleClass:on:click="open" lvt-destroyed="window.__log.push('destroyed A')">A</li><li>B</li>`, `</ul>`],
      0: `<li>C</li>`,
    });
    const a = wrapper.querySelector("li")!;
    executeAction(a, "toggleClass", "open");
    client.updateDOM(wrapper, { 0: "" });
    const lis = [...wrapper.querySelectorAll("li")];
    expect({ same: lis[0] === a, text: lis[0].textContent, open: lis[0].classList.contains("open"), n: lis.length, log: log() })
      .toEqual({ same: true, text: "A", open: true, n: 2, log: [] });
  });

  it("V5: deleting an item while the selection moves off the first item keeps that item's node and typed value", () => {
    client.updateDOM(wrapper, {
      s: [`<ul><li class="`, `" lvt-destroyed="window.__log.push('destroyed A')">A<input></li><li>B</li>`, `</ul>`],
      0: "active",
      1: `<li>C</li>`,
    });
    const a = wrapper.querySelector("li")!;
    const input = a.querySelector("input")!;
    input.value = "typed";
    client.updateDOM(wrapper, { 0: "", 1: "" });
    const lis = [...wrapper.querySelectorAll("li")];
    expect({
      same: lis[0] === a,
      inputSame: lis[0].querySelector("input") === input,
      value: (lis[0].querySelector("input") as HTMLInputElement).value,
      log: log(),
    }).toEqual({ same: true, inputSame: true, value: "typed", log: [] });
  });

  // F6 (caveated: main keeps x's input in y's slot): focus inside a departing
  // root-level element.
  it("V6: a focused input in a departing root-level div", () => {
    client.updateDOM(wrapper, { s: [``, `<div class="y"><input name="y"></div>`], 0: `<div class="x"><input name="x"></div>` });
    const x = wrapper.querySelector('input[name="x"]') as HTMLInputElement;
    x.focus();
    x.value = "typing";
    client.updateDOM(wrapper, { 0: "" });
    expect({ focusedConnected: document.activeElement !== document.body && wrapper.contains(document.activeElement) })
      .toEqual({ focusedConnected: true });
  });
});
