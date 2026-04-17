/**
 * Regression test for the conditional-slot structural transition bug.
 *
 * When a template slot transitions from an empty string ("") to a
 * sub-tree with its own statics ({"0":"text","s":["<mark>","</mark>"]}),
 * the rendered HTML must include the statics. Before the fix, the
 * client's tree renderer silently dropped the transition and the DOM
 * never showed the <mark> tag.
 *
 * This test operates at the TreeRenderer level (no morphdom, no
 * WebSocket) to isolate the reconstruction bug from the DOM-patching
 * layer.
 */

import { LiveTemplateClient } from "../livetemplate-client";

describe("conditional slot structural transition", () => {
  let client: LiveTemplateClient;

  beforeEach(() => {
    client = new LiveTemplateClient();
  });

  it("slot transitioning from empty string to sub-tree with statics renders the statics", () => {
    // Initial tree: slot 1 is a simple empty string (the {{if .Error}}
    // block evaluated to false on the first render).
    const initialTree = {
      s: ["<p>status: ", " error: ", "</p>"],
      0: "ok",
      1: "",
    };
    const r1 = client.applyUpdate(initialTree);
    expect(r1.html).toContain("status: ok");
    expect(r1.html).not.toContain("<mark>");

    // Update: slot 1 transitions from "" to a sub-tree with statics
    // (the {{if .Error}} block now evaluates to true, emitting a
    // <mark> wrapper around the error text).
    const update = {
      1: {
        s: [" — <mark>", "</mark>"],
        0: "something broke",
      },
    };
    const r2 = client.applyUpdate(update);

    // The rendered HTML MUST include the <mark> tag from the sub-tree's
    // statics. Before the fix, r2.html was "<p>status: ok error: </p>"
    // — the sub-tree was silently dropped.
    expect(r2.html).toContain("<mark>");
    expect(r2.html).toContain("something broke");
    expect(r2.html).toContain("</mark>");
    // Full expected: "<p>status: ok error:  — <mark>something broke</mark></p>"
    expect(r2.html).toContain(" — <mark>something broke</mark>");
  });

  it("slot transitioning from sub-tree back to empty string removes the statics", () => {
    // Start with the sub-tree present.
    const initialTree = {
      s: ["<p>status: ", " error: ", "</p>"],
      0: "ok",
      1: {
        s: [" — <mark>", "</mark>"],
        0: "something broke",
      },
    };
    const r1 = client.applyUpdate(initialTree);
    expect(r1.html).toContain("<mark>something broke</mark>");

    // Update: error clears, slot 1 goes back to empty string.
    const update = { 1: "" };
    const r2 = client.applyUpdate(update);

    expect(r2.html).not.toContain("<mark>");
    expect(r2.html).not.toContain("something broke");
  });

  it("multiple transitions back and forth work correctly", () => {
    const initialTree = {
      s: ["<div>", "</div>"],
      0: "",
    };
    client.applyUpdate(initialTree);

    // Empty → sub-tree
    const r1 = client.applyUpdate({
      0: { s: ["<b>", "</b>"], 0: "bold" },
    });
    expect(r1.html).toContain("<b>bold</b>");

    // Sub-tree → different sub-tree
    const r2 = client.applyUpdate({
      0: { s: ["<em>", "</em>"], 0: "italic" },
    });
    expect(r2.html).toContain("<em>italic</em>");
    expect(r2.html).not.toContain("<b>");

    // Sub-tree → empty
    const r3 = client.applyUpdate({ 0: "" });
    expect(r3.html).not.toContain("<em>");
    expect(r3.html).not.toContain("<b>");

    // Empty → sub-tree again
    const r4 = client.applyUpdate({
      0: { s: ["<b>", "</b>"], 0: "back" },
    });
    expect(r4.html).toContain("<b>back</b>");
  });
});
