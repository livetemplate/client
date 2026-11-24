/**
 * A morph that throws partway leaves the page half-applied; the next render
 * must bring it back to exactly what the server sent, with no placeholder left
 * behind. morphdom is wrapped so it throws when it reaches a chosen element.
 */

let boomOn: string | null = null;

jest.mock("morphdom", () => {
  const real = jest.requireActual("morphdom");
  const morph = real.default || real;
  const wrapped = (from: any, to: any, opts: any = {}) =>
    morph(from, to, {
      ...opts,
      onBeforeElUpdated: (f: Element, t: Element) => {
        if (boomOn && t.classList && t.classList.contains(boomOn)) throw new Error("boom");
        return opts.onBeforeElUpdated ? opts.onBeforeElUpdated(f, t) : true;
      },
    });
  return { __esModule: true, default: wrapped };
});

import { LiveTemplateClient } from "../livetemplate-client";

describe("a morph that throws partway", () => {
  let client: LiveTemplateClient;
  let wrapper: HTMLElement;

  beforeEach(() => {
    boomOn = null;
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
});
