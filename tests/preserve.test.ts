/**
 * lvt-preserve attribute tests.
 *
 * lvt-preserve tells the morphdom diff engine "don't touch this element".
 * It's the generic escape hatch for interactive elements whose state
 * lives on the client side — <details open>, <dialog open>, checkbox
 * state, scroll positions, third-party widgets, etc. Without it, any
 * server-driven update that doesn't include the client-managed state
 * clobbers it on the next diff cycle.
 *
 * Equivalent attributes in other frameworks:
 *   - Phoenix LiveView: phx-update="ignore"
 *   - Hotwire Turbo:    data-turbo-permanent
 *   - HTMX:             hx-preserve="true"
 */

import { LiveTemplateClient } from "../livetemplate-client";

describe("lvt-preserve attribute", () => {
  let client: LiveTemplateClient;
  let wrapper: HTMLElement;

  beforeEach(() => {
    client = new LiveTemplateClient();

    // Minimal LiveTemplate-style wrapper the updateDOM path expects.
    // Built via createElement so no innerHTML is needed in the test setup.
    document.body.replaceChildren();
    wrapper = document.createElement("div");
    wrapper.setAttribute("data-lvt-id", "test-preserve");
    document.body.appendChild(wrapper);
  });

  it("preserves an element's open attribute across updates", () => {
    const initialTree = {
      s: [
        `<details lvt-preserve class="picker"><summary>Sessions</summary><div class="list">`,
        `</div></details>`,
      ],
      0: "one two",
    };
    client.updateDOM(wrapper, initialTree);

    const details = wrapper.querySelector("details") as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);

    // Simulate the user tapping the summary to expand the details.
    details.setAttribute("open", "");
    expect(details.open).toBe(true);

    // Apply an update that does NOT contain the open attribute. Without
    // lvt-preserve, morphdom would diff the incoming <details> against
    // the DOM and remove the open attribute to match the server.
    const updateTree = { 0: "one two three" };
    client.updateDOM(wrapper, updateTree);

    const detailsAfter = wrapper.querySelector(
      "details"
    ) as HTMLDetailsElement;
    expect(detailsAfter).not.toBeNull();
    expect(detailsAfter.open).toBe(true);
  });

  it("does not preserve elements without lvt-preserve (control)", () => {
    // Same shape, no lvt-preserve. Verify the open state IS clobbered
    // here — confirming the preservation guarantee in the test above
    // is actually doing work and not just always passing.
    const initialTree = {
      s: [
        `<details class="picker"><summary>Sessions</summary><div class="list">`,
        `</div></details>`,
      ],
      0: "one two",
    };
    client.updateDOM(wrapper, initialTree);

    const details = wrapper.querySelector("details") as HTMLDetailsElement;
    details.setAttribute("open", "");
    expect(details.open).toBe(true);

    const updateTree = { 0: "one two three" };
    client.updateDOM(wrapper, updateTree);

    const detailsAfter = wrapper.querySelector(
      "details"
    ) as HTMLDetailsElement;
    // Without lvt-preserve, morphdom diff removes the user's open attr.
    expect(detailsAfter.open).toBe(false);
  });

  it("lvt-preserve-attrs keeps own attributes but still diffs children", () => {
    // This is the subtler "collapsible picker" case: the <details>
    // element's `open` attribute is user-toggled and must survive
    // server updates, but the <a> cards inside ARE server-authored
    // and their state (e.g. the `current` class marker for the
    // selected item) must reflect the latest tree.
    const initialTree = {
      s: [
        `<details lvt-preserve-attrs class="picker"><summary>Pick</summary>`,
        `</details>`,
      ],
      0: `<a class="card">one</a><a class="card">two</a>`,
    };
    client.updateDOM(wrapper, initialTree);

    const details = wrapper.querySelector("details") as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);

    // User opens the picker.
    details.setAttribute("open", "");
    expect(details.open).toBe(true);

    // Server pushes an update where "two" is now the current card.
    const updateTree = {
      0: `<a class="card">one</a><a class="card current">two</a>`,
    };
    client.updateDOM(wrapper, updateTree);

    const detailsAfter = wrapper.querySelector(
      "details"
    ) as HTMLDetailsElement;
    // User's open state preserved.
    expect(detailsAfter.open).toBe(true);
    // But the children DID update — the second card now has "current".
    const cards = wrapper.querySelectorAll("a.card");
    expect(cards.length).toBe(2);
    expect((cards[0] as HTMLElement).classList.contains("current")).toBe(false);
    expect((cards[1] as HTMLElement).classList.contains("current")).toBe(true);
  });

  it("server can remove lvt-preserve by omitting it in the next full template", () => {
    // lvt-preserve is checked on toEl (the incoming server version), not
    // fromEl (the current DOM). This means the server retains authority:
    // a later render that omits lvt-preserve lets morphdom resume updating
    // the element. Checking fromEl would make the attribute sticky forever.
    const initialTree = {
      s: [`<div lvt-preserve class="widget">`, `</div>`],
      0: "server-initial",
    };
    client.updateDOM(wrapper, initialTree);

    const widget = wrapper.querySelector(".widget") as HTMLElement;
    // Simulate the widget mutating its own DOM.
    widget.textContent = "client-modified";

    // Server sends a NEW template that removes lvt-preserve.
    const removedTree = {
      s: [`<div class="widget">`, `</div>`],
      0: "server-updated",
    };
    client.updateDOM(wrapper, removedTree);

    // Now that lvt-preserve is gone from the template, morphdom should
    // have applied the server's update, overwriting the client state.
    const widgetAfter = wrapper.querySelector(".widget") as HTMLElement;
    expect(widgetAfter).not.toBeNull();
    expect(widgetAfter.textContent).toBe("server-updated");
    expect(widgetAfter.hasAttribute("lvt-preserve")).toBe(false);
  });

  it("server can remove lvt-preserve-attrs by omitting it in a later update", () => {
    // The attribute-copy loop must NOT copy the lvt-preserve-attrs control
    // attribute itself back onto toEl. If it did, the server could never
    // remove the attribute in a future render (it would always be re-added
    // by the copy loop before morphdom sees the diff).
    const initialTree = {
      s: [
        `<details lvt-preserve-attrs class="picker"><summary>Pick</summary>`,
        `</details>`,
      ],
      0: `<a class="card">item</a>`,
    };
    client.updateDOM(wrapper, initialTree);

    const details = wrapper.querySelector("details") as HTMLDetailsElement;
    expect(details.hasAttribute("lvt-preserve-attrs")).toBe(true);

    // Server pushes an update WITHOUT lvt-preserve-attrs — it is opting
    // the element back out of attribute preservation.
    const updateTree = {
      s: [
        `<details class="picker"><summary>Pick</summary>`,
        `</details>`,
      ],
      0: `<a class="card">item</a>`,
    };
    client.updateDOM(wrapper, updateTree);

    const detailsAfter = wrapper.querySelector("details") as HTMLDetailsElement;
    expect(detailsAfter).not.toBeNull();
    // The control attribute must be gone — the server has opted out.
    expect(detailsAfter.hasAttribute("lvt-preserve-attrs")).toBe(false);
  });

  it("preserves checkbox checked state across morphdom updates", () => {
    const initialTree = {
      s: [
        `<form>`,
        `</form>`,
      ],
      0: `<label><input type="checkbox" class="cb" data-key="a" value="a"></label>` +
         `<label><input type="checkbox" class="cb" data-key="b" value="b"></label>`,
    };
    client.updateDOM(wrapper, initialTree);

    const checkboxes = wrapper.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(checkboxes.length).toBe(2);
    expect(checkboxes[0].checked).toBe(false);
    expect(checkboxes[1].checked).toBe(false);

    // User checks the first checkbox.
    checkboxes[0].checked = true;

    // Server pushes a refresh (same HTML, no checked attribute).
    client.updateDOM(wrapper, initialTree);

    const afterUpdate = wrapper.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(afterUpdate[0].checked).toBe(true);
    expect(afterUpdate[1].checked).toBe(false);
  });

  it("preserves radio button checked state across morphdom updates", () => {
    const initialTree = {
      s: [
        `<form>`,
        `</form>`,
      ],
      0: `<input type="radio" name="choice" data-key="x" value="x">` +
         `<input type="radio" name="choice" data-key="y" value="y">`,
    };
    client.updateDOM(wrapper, initialTree);

    const radios = wrapper.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    radios[1].checked = true;

    client.updateDOM(wrapper, initialTree);

    const afterUpdate = wrapper.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(afterUpdate[0].checked).toBe(false);
    expect(afterUpdate[1].checked).toBe(true);
  });

  it("preserves radio selection when server sends a different default", () => {
    const initialTree = {
      s: [
        `<form>`,
        `</form>`,
      ],
      0: `<input type="radio" name="opt" data-key="a" value="a">` +
         `<input type="radio" name="opt" data-key="b" value="b">`,
    };
    client.updateDOM(wrapper, initialTree);

    const radios = wrapper.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    radios[1].checked = true;

    // Server sends update with radio A pre-checked via the checked attribute.
    const updateTree = {
      s: [
        `<form>`,
        `</form>`,
      ],
      0: `<input type="radio" name="opt" data-key="a" value="a" checked>` +
         `<input type="radio" name="opt" data-key="b" value="b">`,
    };
    client.updateDOM(wrapper, updateTree);

    const afterUpdate = wrapper.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(afterUpdate[0].checked).toBe(false);
    expect(afterUpdate[1].checked).toBe(true);
  });

  it("preserves checkbox indeterminate state across morphdom updates", () => {
    const initialTree = {
      s: [`<form>`, `</form>`],
      0: `<input type="checkbox" class="select-all" value="all">`,
    };
    client.updateDOM(wrapper, initialTree);

    const cb = wrapper.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    cb.indeterminate = true;

    client.updateDOM(wrapper, initialTree);

    const cbAfter = wrapper.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(cbAfter.indeterminate).toBe(true);
  });

  it("data-lvt-force-update overrides checkbox preservation", () => {
    // Parent content differs between renders (v1 → v2) so morphdom
    // reaches the checkbox via normal diffing, not via the isEqualNode
    // subtree bypass (which the next test covers separately).
    const initialTree = {
      s: [`<form>`, `</form>`],
      0: `<div data-key="w"><span>v1</span><input type="checkbox" data-lvt-force-update value="f"></div>`,
    };
    client.updateDOM(wrapper, initialTree);

    const cb = wrapper.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    cb.checked = true;

    const updateTree = {
      s: [`<form>`, `</form>`],
      0: `<div data-key="w"><span>v2</span><input type="checkbox" data-lvt-force-update value="f"></div>`,
    };
    client.updateDOM(wrapper, updateTree);

    const cbAfter = wrapper.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(cbAfter.checked).toBe(false);
  });

  it("data-lvt-force-update overrides radio preservation", () => {
    const initialTree = {
      s: [`<form>`, `</form>`],
      0: `<div data-key="r"><span>v1</span>` +
         `<input type="radio" name="fg" data-lvt-force-update value="a">` +
         `<input type="radio" name="fg" value="b"></div>`,
    };
    client.updateDOM(wrapper, initialTree);

    const radios = wrapper.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    radios[1].checked = true;

    const updateTree = {
      s: [`<form>`, `</form>`],
      0: `<div data-key="r"><span>v2</span>` +
         `<input type="radio" name="fg" data-lvt-force-update value="a" checked>` +
         `<input type="radio" name="fg" value="b"></div>`,
    };
    client.updateDOM(wrapper, updateTree);

    const afterUpdate = wrapper.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(afterUpdate[0].checked).toBe(true);
    expect(afterUpdate[1].checked).toBe(false);
  });

  it("data-lvt-force-update is one-shot and self-clears after the render", () => {
    const forceTree = {
      s: [`<form>`, `</form>`],
      0: `<div data-key="lc"><span>v1</span><input type="checkbox" data-lvt-force-update value="lc"></div>`,
    };
    client.updateDOM(wrapper, forceTree);

    const cb = wrapper.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    cb.checked = true;

    // Server sends force-update to reset the checkbox.
    const resetTree = {
      s: [`<form>`, `</form>`],
      0: `<div data-key="lc"><span>v2</span><input type="checkbox" data-lvt-force-update value="lc"></div>`,
    };
    client.updateDOM(wrapper, resetTree);

    const afterReset = wrapper.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(afterReset.checked).toBe(false);
    // Attribute should be auto-stripped after processing.
    expect(afterReset.hasAttribute("data-lvt-force-update")).toBe(false);

    // User checks again.
    afterReset.checked = true;

    // Server sends a normal update (no data-lvt-force-update) — user
    // state should now be preserved since the attribute self-cleared.
    const normalTree = {
      s: [`<form>`, `</form>`],
      0: `<div data-key="lc"><span>v3</span><input type="checkbox" value="lc"></div>`,
    };
    client.updateDOM(wrapper, normalTree);

    const afterNormal = wrapper.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(afterNormal.checked).toBe(true);
  });

  it("data-lvt-force-update on descendant bypasses ancestor isEqualNode short-circuit", () => {
    // When the parent container is structurally equal across renders,
    // isEqualNode would return true and skip the subtree. The subtree
    // check ensures a descendant with data-lvt-force-update still
    // gets processed.
    const tree = {
      s: [`<form>`, `</form>`],
      0: `<div class="stable"><input type="checkbox" data-lvt-force-update value="x"></div>`,
    };
    client.updateDOM(wrapper, tree);

    const cb = wrapper.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    cb.checked = true;

    // Same tree — parent div is structurally equal, but descendant
    // input has data-lvt-force-update so morphdom must still traverse.
    client.updateDOM(wrapper, tree);

    const cbAfter = wrapper.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(cbAfter.checked).toBe(false);
  });

  it("preserves the element's children as well", () => {
    // lvt-preserve is a full-element bail-out: attributes, children,
    // everything stays as-is. Useful for third-party widgets that
    // mutate their own DOM.
    const initialTree = {
      s: [`<div lvt-preserve class="widget">`, `</div>`],
      0: "initial content",
    };
    client.updateDOM(wrapper, initialTree);

    const widget = wrapper.querySelector(".widget") as HTMLElement;
    expect(widget.textContent).toBe("initial content");

    // Simulate a third-party widget mutating its own children via
    // safe DOM methods (the livetemplate contract applies regardless
    // of how the client-side mutation happened).
    widget.replaceChildren();
    const span = document.createElement("span");
    span.textContent = "widget-modified";
    widget.appendChild(span);

    // Server sends an update that would otherwise replace the content.
    const updateTree = { 0: "server-updated content" };
    client.updateDOM(wrapper, updateTree);

    const widgetAfter = wrapper.querySelector(".widget") as HTMLElement;
    // The widget's own mutation survives — morphdom never touched it.
    expect(widgetAfter.textContent).toBe("widget-modified");
    expect(widgetAfter.querySelector("span")).not.toBeNull();
  });
});
