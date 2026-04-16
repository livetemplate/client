/**
 * Regression test for the inline <script> content duplication bug.
 *
 * When the reconstructed HTML contains an inline <script> tag and
 * updateDOM sets tempWrapper.innerHTML, browsers parse the script
 * content specially and can create phantom duplicate DOM nodes after
 * the script boundary. morphdom then sees doubled elements and
 * patches them into the live DOM.
 *
 * This test operates at the updateDOM level (tree + morphdom) to
 * reproduce the exact conditions: a template with a <script> block
 * followed by more HTML elements.
 */

import { LiveTemplateClient } from "../livetemplate-client";

describe("inline script duplication", () => {
  let client: LiveTemplateClient;
  let wrapper: HTMLElement;

  beforeEach(() => {
    client = new LiveTemplateClient();
    document.body.replaceChildren();
    wrapper = document.createElement("div");
    wrapper.setAttribute("data-lvt-id", "script-dup-test");
    document.body.appendChild(wrapper);
  });

  it("elements after an inline script are NOT duplicated", () => {
    // Initial tree: content + script + more content after.
    // The tree shape mirrors what devbox-dash's claude.tmpl produces
    // when chat messages are followed by a scroll-to-bottom script
    // and then a key-grid div.
    const tree = {
      s: [
        '<div class="chat">messages here</div>',
        '<script>(function(){ /* scroll */ })();</script>',
        '<div class="after-script">',
        "</div>",
      ],
      0: "", // between chat and script (slot 0)
      1: "", // between script and after-script (slot 1)
      2: "unique-content-that-should-appear-once", // inside after-script
    };

    client.updateDOM(wrapper, tree);

    // Count: the div.after-script should appear exactly ONCE.
    const afterScriptDivs = wrapper.querySelectorAll(".after-script");
    expect(afterScriptDivs.length).toBe(1);

    // The unique content should appear once.
    const textOccurrences = (wrapper.textContent || "").split(
      "unique-content-that-should-appear-once"
    ).length - 1;
    expect(textOccurrences).toBe(1);
  });

  it("a second updateDOM does not cause further duplication", () => {
    const tree = {
      s: [
        '<div class="before">',
        '</div><script>var x = 1;</script><div class="after">',
        "</div>",
      ],
      0: "initial",
      1: "initial-after",
    };

    client.updateDOM(wrapper, tree);
    expect(wrapper.querySelectorAll(".after").length).toBe(1);

    // Apply an update that changes the dynamic slot but keeps the same structure.
    const update = { 0: "updated", 1: "updated-after" };
    client.updateDOM(wrapper, update);

    expect(wrapper.querySelectorAll(".after").length).toBe(1);
    expect(wrapper.textContent).toContain("updated-after");
  });
});
