/**
 * Regression test: an action that produces NO render diff must still resolve
 * its loading lifecycle.
 *
 * Bug: updateDOM() short-circuits (skips morphdom) when the update has no
 * changes and no statics — an empty diff, e.g. re-submitting the same value or
 * any idempotent action. That early-return also skipped firing the form
 * lifecycle (handleResponse → lvt:done), so loading indicators wired to
 * lvt-el:*:on:pending/done (and lvt-form:disable-with / form aria-busy) stayed
 * stuck forever. The fix resolves the lifecycle before the early-return.
 */

import { LiveTemplateClient } from "../livetemplate-client";
import { setupReactiveAttributeListeners } from "../dom/reactive-attributes";

describe("loading lifecycle on an empty-diff response", () => {
  let client: LiveTemplateClient;

  beforeEach(() => {
    document.body.innerHTML = "";
    client = new LiveTemplateClient();
    setupReactiveAttributeListeners();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("clears reactive on:done state and restores the form even with no DOM diff", () => {
    const wrapper = document.createElement("div");
    const form = document.createElement("form");
    const button = document.createElement("button");
    button.setAttribute("name", "greet");
    button.setAttribute("lvt-el:addClass:on:pending", "is-loading");
    button.setAttribute("lvt-el:removeClass:on:done", "is-loading");
    button.textContent = "Say hi";
    form.appendChild(button);
    wrapper.appendChild(form);
    document.body.appendChild(wrapper);

    // Simulate the pending state applied when the action is sent: the reactive
    // attribute added the class, and the form lifecycle marked the submission
    // active (aria-busy on the form, the active button tracked).
    button.classList.add("is-loading");
    form.setAttribute("aria-busy", "true");
    (client as any).formLifecycleManager.setActiveSubmission(
      form,
      button,
      button.textContent
    );

    let doneFired = false;
    document.addEventListener(
      "lvt:done",
      () => {
        doneFired = true;
      },
      true
    );

    // The server responds to a no-op action with an empty update tree.
    client.updateDOM(wrapper, {} as any, {
      success: true,
      action: "greet",
    } as any);

    expect(doneFired).toBe(true); // lifecycle resolved despite the empty diff
    expect(button.classList.contains("is-loading")).toBe(false); // on:done applied
    expect(form.hasAttribute("aria-busy")).toBe(false); // form state restored
  });
});
