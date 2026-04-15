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
