/**
 * One-shot scroll/autofocus guards must survive morphdom.
 *
 * `lvt-fx:scroll="into-view"` and `lvt-autofocus` are meant to fire ONCE per
 * element. Their guards are runtime-only attributes the client stamps on the live
 * DOM (`data-lvt-iv-done`, `data-lvt-autofocused`) — the server never emits them.
 * Without preservation, morphdom strips them on every render (the incoming `toEl`
 * lacks them), so both directives re-fire on unrelated re-renders (re-scrolling /
 * re-stealing focus to a stale target — e.g. a background status poll yanking the
 * viewport back to the last-jumped element).
 *
 * onBeforeElUpdated copies the guard onto `toEl` WHILE the directive is still
 * present, so morphdom keeps it; when the server drops the directive the guard
 * falls away naturally and the directive re-arms on re-add.
 */

import { LiveTemplateClient } from "../livetemplate-client";

describe("one-shot scroll/autofocus guards survive morphdom", () => {
  let client: LiveTemplateClient;
  let wrapper: HTMLElement;
  let scrollSpy: jest.Mock;

  beforeEach(() => {
    // jsdom has no scrollIntoView; mock it so the into-view directive can fire and
    // we can count how often it scrolls (the whole point: it must fire once, not
    // on every re-render).
    scrollSpy = jest.fn();
    (Element.prototype as any).scrollIntoView = scrollSpy;
    client = new LiveTemplateClient();
    document.body.replaceChildren();
    wrapper = document.createElement("div");
    wrapper.setAttribute("data-lvt-id", "test-guard");
    document.body.appendChild(wrapper);
  });

  it("scrolls once, then NOT again on an unrelated re-render (guard preserved)", () => {
    client.updateDOM(wrapper, {
      s: [`<div class="target" lvt-fx:scroll="into-view">x</div><span class="sib">`, `</span>`],
      0: "a",
    });
    const target = wrapper.querySelector(".target") as HTMLElement;
    expect(target).not.toBeNull();
    expect(scrollSpy).toHaveBeenCalledTimes(1); // fired once on first paint
    expect(target.dataset.lvtIvDone).toBe("1"); // directive stamped its guard

    // Unrelated update: only the sibling text changes; the target keeps the directive.
    client.updateDOM(wrapper, { 0: "b" });

    const after = wrapper.querySelector(".target") as HTMLElement;
    expect(after).toBe(target); // morphdom reused the node
    expect(after.dataset.lvtIvDone).toBe("1"); // guard PRESERVED across the render
    expect(scrollSpy).toHaveBeenCalledTimes(1); // NOT re-scrolled — the bug's fix
    expect(wrapper.querySelector(".sib")!.textContent).toBe("b"); // real update applied
  });

  it("re-arms and scrolls again after the directive is removed then re-added", () => {
    client.updateDOM(wrapper, { s: [`<div class="target" lvt-fx:scroll="into-view">`, `</div>`], 0: "x" });
    expect(scrollSpy).toHaveBeenCalledTimes(1);

    // Server drops the directive (scroll target moved elsewhere) → guard must fall away.
    client.updateDOM(wrapper, { s: [`<div class="target">`, `</div>`], 0: "x" });
    const mid = wrapper.querySelector(".target") as HTMLElement;
    expect(mid.hasAttribute("lvt-fx:scroll")).toBe(false);
    expect(mid.dataset.lvtIvDone).toBeUndefined(); // dropped

    // Server re-targets this element → it must scroll AGAIN (re-armed).
    client.updateDOM(wrapper, { s: [`<div class="target" lvt-fx:scroll="into-view">`, `</div>`], 0: "x" });
    expect(scrollSpy).toHaveBeenCalledTimes(2);
  });

  it("preserves data-lvt-autofocused while lvt-autofocus stays present", () => {
    client.updateDOM(wrapper, {
      s: [`<textarea class="target" lvt-autofocus></textarea><span class="sib">`, `</span>`],
      0: "a",
    });
    const target = wrapper.querySelector(".target") as HTMLElement;
    target.setAttribute("data-lvt-autofocused", "true");

    client.updateDOM(wrapper, { 0: "b" });

    const after = wrapper.querySelector(".target") as HTMLElement;
    expect(after.getAttribute("data-lvt-autofocused")).toBe("true"); // no re-focus
    expect(wrapper.querySelector(".sib")!.textContent).toBe("b");
  });
});
