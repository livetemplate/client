/**
 * Client-owned `lvt-el:` state must survive morphdom (#147).
 *
 * `lvt-el:toggleClass` exists to hold client-side UI state, but the server never emits that class,
 * so the incoming `toEl` carries the server's original `class` and morphdom's attribute diff used to
 * overwrite the live one — a dropdown held open with `lvt-el:toggleClass:on:click="open"` closed
 * under the user on any unrelated re-render. Same bug for `setAttr` / `toggleAttr`.
 *
 * These tests drive the REAL pipeline: `executeAction` (exactly what the click/click-away delegation
 * calls, with the target already resolved) followed by `client.updateDOM`, which runs a real morph.
 * The browser e2e only reproduces ~1 run in 4 — this is the deterministic gate.
 *
 * Semantics under test: the client overlay wins on CONFLICT, the server reowns on AGREEMENT.
 */

import { LiveTemplateClient } from "../livetemplate-client";
import { executeAction, resolveTarget } from "../dom/reactive-attributes";
import { reapplyClientOwnedState } from "../dom/client-owned-state";

describe("client-owned lvt-el state survives morphdom", () => {
  let client: LiveTemplateClient;
  let wrapper: HTMLElement;

  beforeEach(() => {
    client = new LiveTemplateClient();
    document.body.replaceChildren();
    wrapper = document.createElement("div");
    wrapper.setAttribute("data-lvt-id", "test-owned");
    document.body.appendChild(wrapper);
  });

  it("keeps a toggled class across an unrelated re-render (the #147 repro)", () => {
    client.updateDOM(wrapper, {
      s: [
        `<div class="tb-dropdown" lvt-el:toggleClass:on:click="open"><button>View</button></div><span class="sib">`,
        `</span>`,
      ],
      0: "a",
    });
    const dropdown = wrapper.querySelector(".tb-dropdown") as HTMLElement;
    executeAction(dropdown, "toggleClass", "open"); // user clicks the trigger
    expect(dropdown.classList.contains("open")).toBe(true);

    // Any unrelated render — in prereview, a sibling action whose data feeds the panel.
    client.updateDOM(wrapper, { 0: "b" });

    const after = wrapper.querySelector(".tb-dropdown") as HTMLElement;
    expect(after).toBe(dropdown); // morphdom reused the node
    expect(after.classList.contains("open")).toBe(true); // the menu stays open — the fix
    expect(after.classList.contains("tb-dropdown")).toBe(true); // server's base class intact
    expect(wrapper.querySelector(".sib")!.textContent).toBe("b"); // and the real update landed
  });

  it("keeps a class the client REMOVED from a class the server still emits", () => {
    // click-away on a panel the server rendered open. An add-only record would not fix this:
    // morphdom would re-add `open` from toEl on the very next render.
    client.updateDOM(wrapper, {
      s: [`<div class="panel open" lvt-el:removeClass:on:click-away="open"></div><span class="sib">`, `</span>`],
      0: "a",
    });
    const panel = wrapper.querySelector(".panel") as HTMLElement;
    expect(panel.classList.contains("open")).toBe(true); // server opened it

    executeAction(panel, "removeClass", "open"); // user clicks away
    client.updateDOM(wrapper, { 0: "b" });

    const after = wrapper.querySelector(".panel") as HTMLElement;
    expect(after).toBe(panel);
    expect(after.classList.contains("open")).toBe(false); // stays closed
    expect(wrapper.querySelector(".sib")!.textContent).toBe("b");
  });

  it("does not resurrect a class after the client toggles back to the server's state", () => {
    client.updateDOM(wrapper, {
      s: [`<div class="tb-dropdown" lvt-el:toggleClass:on:click="open"></div><span class="sib">`, `</span>`],
      0: "a",
    });
    const dropdown = wrapper.querySelector(".tb-dropdown") as HTMLElement;

    executeAction(dropdown, "toggleClass", "open"); // open
    executeAction(dropdown, "toggleClass", "open"); // close again
    expect(dropdown.classList.contains("open")).toBe(false);

    client.updateDOM(wrapper, { 0: "b" });

    expect((wrapper.querySelector(".tb-dropdown") as HTMLElement).classList.contains("open")).toBe(false);
  });

  it("keeps setAttr and toggleAttr state across a morph, including a toggle-OFF", () => {
    client.updateDOM(wrapper, {
      s: [`<div class="row" aria-expanded="false" hidden></div><span class="sib">`, `</span>`],
      0: "a",
    });
    const row = wrapper.querySelector(".row") as HTMLElement;

    executeAction(row, "setAttr", "aria-expanded:true"); // conflicts with the server's "false"
    executeAction(row, "toggleAttr", "hidden"); // toggles OFF an attr the server emits

    client.updateDOM(wrapper, { 0: "b" });

    const after = wrapper.querySelector(".row") as HTMLElement;
    expect(after).toBe(row);
    expect(after.getAttribute("aria-expanded")).toBe("true"); // client value survives
    expect(after.hasAttribute("hidden")).toBe(false); // toggle-off survives
    expect(wrapper.querySelector(".sib")!.textContent).toBe("b");
  });

  it("survives on the element data-lvt-target resolves to, which carries no lvt-el attribute", () => {
    client.updateDOM(wrapper, {
      s: [
        `<div class="menu"><button lvt-el:addClass:on:click="open" data-lvt-target="closest:.menu"></button></div><span class="sib">`,
        `</span>`,
      ],
      0: "a",
    });
    const button = wrapper.querySelector("button") as HTMLElement;
    const menu = wrapper.querySelector(".menu") as HTMLElement;

    // Both call sites in reactive-attributes.ts pass the RESOLVED target, so the record keys on it.
    const target = resolveTarget(button);
    expect(target).toBe(menu);
    expect(menu.hasAttribute("lvt-el:addClass:on:click")).toBe(false); // no directive on the target
    executeAction(target, "addClass", "open");

    client.updateDOM(wrapper, { 0: "b" });

    expect((wrapper.querySelector(".menu") as HTMLElement).classList.contains("open")).toBe(true);
    expect(wrapper.querySelector(".sib")!.textContent).toBe("b");
  });

  it("hands the class back to the server once the server starts emitting it", () => {
    client.updateDOM(wrapper, {
      s: [`<div class="tb-dropdown" lvt-el:toggleClass:on:click="open"></div><span class="sib">`, `</span>`],
      0: "a",
    });
    const dropdown = wrapper.querySelector(".tb-dropdown") as HTMLElement;
    executeAction(dropdown, "toggleClass", "open");

    // Server now emits `open` too — client and server agree, so the overlay retires.
    client.updateDOM(wrapper, {
      s: [`<div class="tb-dropdown open" lvt-el:toggleClass:on:click="open"></div><span class="sib">`, `</span>`],
      0: "a",
    });
    expect((wrapper.querySelector(".tb-dropdown") as HTMLElement).classList.contains("open")).toBe(true);

    // Server drops it again. The class goes away — it did NOT linger as a client overlay.
    client.updateDOM(wrapper, {
      s: [`<div class="tb-dropdown" lvt-el:toggleClass:on:click="open"></div><span class="sib">`, `</span>`],
      0: "a",
    });
    expect((wrapper.querySelector(".tb-dropdown") as HTMLElement).classList.contains("open")).toBe(false);
  });

  it("lets setAttr:class and toggleClass coexist without stomping each other", () => {
    // setAttr writes the whole class attribute; toggleClass writes one token. The overlay applies
    // attrs before classes so the wholesale write lands first and the token layers on top.
    client.updateDOM(wrapper, {
      s: [`<div class="row"></div><span class="sib">`, `</span>`],
      0: "a",
    });
    const row = wrapper.querySelector(".row") as HTMLElement;

    executeAction(row, "setAttr", "class:row selected");
    executeAction(row, "toggleClass", "open");

    client.updateDOM(wrapper, { 0: "b" });

    const after = wrapper.querySelector("div") as HTMLElement;
    expect(after.classList.contains("selected")).toBe(true); // setAttr's value survives
    expect(after.classList.contains("open")).toBe(true); // and the toggled class wasn't stomped
    expect(wrapper.querySelector(".sib")!.textContent).toBe("b");
  });

  it("does not leak one element's state onto another", () => {
    const recorded = document.createElement("div");
    executeAction(recorded, "addClass", "open");

    // A different element that never had an action run on it must come back untouched.
    const fresh = document.createElement("div");
    const incoming = document.createElement("div");
    incoming.className = "base";
    reapplyClientOwnedState(fresh, incoming);
    expect(incoming.className).toBe("base");

    // The recorded element's state, by contrast, lands on its own incoming node.
    const ownIncoming = document.createElement("div");
    ownIncoming.className = "base";
    reapplyClientOwnedState(recorded, ownIncoming);
    expect(ownIncoming.classList.contains("open")).toBe(true);
  });
});
