/**
 * Attribute registry — the public extension point for lvt-* attributes.
 *
 * These tests cover the contract an external author programs against. The
 * built-ins' own behaviour is covered by the pre-existing suites (they were not
 * rewritten by the registry migration, only re-dispatched), so nothing here
 * duplicates them.
 */

import {
  attachRegistryRoot,
  detachRegistryRoot,
  disposeHandlers,
  getRegisteredAttributes,
  isDeclarative,
  registerAttribute,
  resolveCategory,
  runHandlers,
  teardownHandler,
  __resetRegistryForTesting,
  type AttributeHandler,
  type ElementContext,
  type RegistryRoot,
  type SendFn,
} from "../attribute-registry";

const noopSend: SendFn = () => {};

function makeRoot(html: string): Element {
  document.body.innerHTML = `<div data-lvt-id="lvt-test">${html}</div>`;
  return document.body.firstElementChild as Element;
}

/**
 * One render pass, through the SAME entry point updateDOM uses. Calling
 * runHandlers rather than re-implementing the gate-and-dispatch loop is what
 * makes these tests pin production behaviour instead of a copy of it.
 */
function render(root: Element, domChanged = true, send: SendFn = noopSend): void {
  runHandlers(getRegisteredAttributes(), { scanRoot: root, wrapperRoot: root }, send, domChanged);
}

/** A live client, as the registry sees one. Detached automatically in afterEach. */
function liveRoot(root: Element): RegistryRoot {
  const registryRoot: RegistryRoot = { root: () => root, send: noopSend };
  attachedRoots.push(registryRoot);
  return registryRoot;
}

let attachedRoots: RegistryRoot[] = [];
let warn: jest.SpyInstance;
let error: jest.SpyInstance;

beforeEach(() => {
  __resetRegistryForTesting();
  warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  error = jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  // Detach here rather than at the end of each test: an assertion that fails
  // mid-test would otherwise leak a live root into the next one.
  for (const root of attachedRoots) detachRegistryRoot(root);
  attachedRoots = [];
  warn.mockRestore();
  error.mockRestore();
  document.body.innerHTML = "";
});

describe("declarative layer", () => {
  it("fires onElementAdded exactly once across repeated renders", () => {
    const added = jest.fn();
    registerAttribute({ attribute: "lvt-x:copy", onElementAdded: added });

    const root = makeRoot(`<button lvt-x:copy="https://example.test">Copy</button>`);
    render(root);
    render(root);
    render(root);

    expect(added).toHaveBeenCalledTimes(1);
  });

  it("matches an attribute containing ':' without the author escaping anything", () => {
    const added = jest.fn();
    // The author writes a plain name. If the framework did not escape it, this
    // selector would throw SyntaxError inside querySelectorAll.
    registerAttribute({ attribute: "lvt-x:deep:name", onElementAdded: added });

    const root = makeRoot(`<div lvt-x:deep:name="v"></div>`);
    render(root);

    expect(added).toHaveBeenCalledTimes(1);
  });

  it("fires onElementRemoved when a server diff drops the attribute", () => {
    const removed = jest.fn();
    registerAttribute({ attribute: "lvt-x:copy", onElementAdded: () => {}, onElementRemoved: removed });

    const root = makeRoot(`<button lvt-x:copy="a">Copy</button>`);
    render(root);
    expect(removed).not.toHaveBeenCalled();

    root.firstElementChild!.removeAttribute("lvt-x:copy");
    render(root);

    expect(removed).toHaveBeenCalledTimes(1);
  });

  it("fires onElementRemoved when the element detaches", () => {
    const removed = jest.fn();
    registerAttribute({ attribute: "lvt-x:copy", onElementAdded: () => {}, onElementRemoved: removed });

    const root = makeRoot(`<button lvt-x:copy="a">Copy</button>`);
    render(root);

    root.innerHTML = "";
    render(root);

    expect(removed).toHaveBeenCalledTimes(1);
  });

  it("re-adds an element that lost and regained the attribute", () => {
    const added = jest.fn();
    const removed = jest.fn();
    registerAttribute({ attribute: "lvt-x:copy", onElementAdded: added, onElementRemoved: removed });

    const root = makeRoot(`<button lvt-x:copy="a"></button>`);
    const el = root.firstElementChild!;
    render(root);
    el.removeAttribute("lvt-x:copy");
    render(root);
    el.setAttribute("lvt-x:copy", "b");
    render(root);

    expect(added).toHaveBeenCalledTimes(2);
    expect(removed).toHaveBeenCalledTimes(1);
  });

  it("warns on an empty value and does not invoke the callback", () => {
    const added = jest.fn();
    registerAttribute({ attribute: "lvt-x:copy", onElementAdded: added });

    render(makeRoot(`<button lvt-x:copy=""></button>`));

    expect(added).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(" ")).toContain("lvt-x:copy");
  });

  it("re-reads ctx.value after a re-render rather than capturing it", () => {
    let ctx: ElementContext | undefined;
    registerAttribute({ attribute: "lvt-x:copy", onElementAdded: (_el, c) => { ctx = c; } });

    const root = makeRoot(`<button lvt-x:copy="first"></button>`);
    render(root);
    expect(ctx!.value).toBe("first");

    // A server re-render changes the value; the listener captured ctx long ago.
    root.firstElementChild!.setAttribute("lvt-x:copy", "second");
    expect(ctx!.value).toBe("second");
  });

  it("resolves ctx.send to the transport live at call time, not at wiring time", () => {
    let ctx: ElementContext | undefined;
    registerAttribute({
      attribute: "lvt-x:rating",
      needsServerChannel: true,
      onElementAdded: (_el, c) => { ctx = c; },
    });

    const root = makeRoot(`<div lvt-x:rating="SetRating"></div>`);
    const first: SendFn = jest.fn();
    render(root, true, first);

    // Reconnect rebuilds the transport; the captured ctx must follow it.
    const second: SendFn = jest.fn();
    render(root, true, second);

    ctx!.send!({ action: "SetRating", data: { stars: 4 } });
    expect(second).toHaveBeenCalledWith({ action: "SetRating", data: { stars: 4 } });
    expect(first).not.toHaveBeenCalled();
  });

  it("withholds send from a handler that did not ask for it", () => {
    let ctx: ElementContext | undefined;
    registerAttribute({ attribute: "lvt-x:visual", onElementAdded: (_el, c) => { ctx = c; } });

    render(makeRoot(`<div lvt-x:visual="v"></div>`), true, jest.fn());

    expect(ctx!.send).toBeUndefined();
  });

  it("keeps rendering after a handler callback throws", () => {
    const later = jest.fn();
    registerAttribute({
      attribute: "lvt-x:bad",
      onElementAdded: () => { throw new Error("boom"); },
    });
    registerAttribute({ attribute: "lvt-x:good", onElementAdded: later });

    render(makeRoot(`<div lvt-x:bad="a"></div><div lvt-x:good="b"></div>`));

    expect(later).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
  });

  it("reuses one context per element across renders", () => {
    const seen: unknown[] = [];
    registerAttribute({
      attribute: "lvt-x:copy",
      onElement: (_el, ctx) => { seen.push(ctx); },
    });

    const root = makeRoot(`<button lvt-x:copy="a"></button>`);
    render(root);
    render(root);
    render(root);

    // Three dispatches, one context: the members are accessors, so a handler
    // that captured the first one keeps reading current values through it.
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(1);
  });

  it("sweeps tracked elements on teardown", () => {
    const removed = jest.fn();
    registerAttribute({ attribute: "lvt-x:copy", onElementAdded: () => {}, onElementRemoved: removed });

    const root = makeRoot(`<button lvt-x:copy="a"></button>`);
    render(root);
    teardownHandler(getRegisteredAttributes()[0], root);

    expect(removed).toHaveBeenCalledTimes(1);
  });
});

describe("dispose", () => {
  it("runs root-less cleanup for handlers that declare it", () => {
    const disposed = jest.fn();
    registerAttribute({ name: "global-state", selectors: ["*"], setup: () => {}, dispose: disposed });
    registerAttribute({ name: "no-global-state", selectors: ["*"], setup: () => {} });

    disposeHandlers(getRegisteredAttributes());

    expect(disposed).toHaveBeenCalledTimes(1);
  });

  it("keeps disposing after one handler throws", () => {
    const later = jest.fn();
    registerAttribute({
      name: "bad", selectors: ["*"], setup: () => {},
      dispose: () => { throw new Error("boom"); },
    });
    registerAttribute({ name: "good", selectors: ["*"], setup: () => {}, dispose: later });

    disposeHandlers(getRegisteredAttributes());

    expect(later).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
  });
});

describe("category", () => {
  it("derives fire-on-change when onElement is declared", () => {
    expect(resolveCategory({ attribute: "lvt-x:a", onElement: () => {} })).toBe("fire-on-change");
  });

  it("derives wire-idempotent for wiring-only handlers", () => {
    expect(resolveCategory({ attribute: "lvt-x:a", onElementAdded: () => {} })).toBe("wire-idempotent");
  });

  it("lets an explicit category win over the derivation", () => {
    expect(
      resolveCategory({ attribute: "lvt-x:a", onElementAdded: () => {}, category: "always" })
    ).toBe("always");
  });

  it("skips wire-idempotent handlers when the render added nothing", () => {
    const added = jest.fn();
    const perRender = jest.fn();
    registerAttribute({ attribute: "lvt-x:wire", onElementAdded: added });
    registerAttribute({ attribute: "lvt-x:live", onElement: perRender });

    const root = makeRoot(`<div lvt-x:wire="a"></div><div lvt-x:live="b"></div>`);
    render(root, false);

    expect(added).not.toHaveBeenCalled();
    expect(perRender).toHaveBeenCalledTimes(1);
  });
});

describe("registration", () => {
  it("warns when two handlers claim the same name, and keeps both", () => {
    registerAttribute({ attribute: "lvt-x:copy", onElementAdded: () => {} });
    registerAttribute({ attribute: "lvt-x:copy", onElementAdded: () => {} });

    expect(getRegisteredAttributes()).toHaveLength(2);
    expect(warn.mock.calls.flat().join(" ")).toContain("already claims this name");
  });

  it("folds case when comparing names, because the DOM does", () => {
    registerAttribute({ attribute: "lvt-x:doThing", onElementAdded: () => {} });
    registerAttribute({ attribute: "lvt-x:dothing", onElementAdded: () => {} });

    expect(warn.mock.calls.flat().join(" ")).toContain("already claims this name");
  });

  it("does NOT warn for two low-level handlers that both walk '*'", () => {
    // The two built-in descendant walkers are a legitimate overlap: `selectors`
    // is descriptive and the warning must not key on it, or the registry warns
    // about its own core handlers on every page load.
    registerAttribute({ name: "walker-a", selectors: ["*"], category: "wire-idempotent", setup: () => {} });
    registerAttribute({ name: "walker-b", selectors: ["*"], category: "wire-idempotent", setup: () => {} });

    expect(warn).not.toHaveBeenCalled();
  });

  it("rejects a handler declaring both attribute and selectors", () => {
    registerAttribute({ attribute: "lvt-x:a", selectors: ["[lvt-x\\:a]"], setup: () => {} } as any);

    expect(getRegisteredAttributes()).toHaveLength(0);
    expect(warn.mock.calls.flat().join(" ")).toContain("never both");
  });

  it("rejects a low-level handler with no setup()", () => {
    registerAttribute({ name: "x", selectors: ["[x]"] } as any);
    expect(getRegisteredAttributes()).toHaveLength(0);
  });

  it("rejects a handler that is neither declarative nor low-level", () => {
    registerAttribute({ name: "x" } as any);
    expect(getRegisteredAttributes()).toHaveLength(0);
  });

  it("catches up immediately when registered after a client is live", () => {
    const root = makeRoot(`<button lvt-x:copy="a"></button>`);
    const registryRoot = liveRoot(root);
    attachRegistryRoot(registryRoot);

    const added = jest.fn();
    // No render() call: registration alone must reach the live DOM, because a
    // second bundle can only load after core has already connected.
    registerAttribute({ attribute: "lvt-x:copy", onElementAdded: added });

    expect(added).toHaveBeenCalledTimes(1);
  });

  it("catches a low-level handler up too", () => {
    const root = makeRoot(`<div></div>`);
    const registryRoot = liveRoot(root);
    attachRegistryRoot(registryRoot);

    const setup = jest.fn();
    registerAttribute({ name: "late", selectors: ["*"], category: "fire-on-change", setup });

    expect(setup).toHaveBeenCalledTimes(1);
  });

  it("does not catch up after the client detaches", () => {
    const root = makeRoot(`<button lvt-x:copy="a"></button>`);
    const registryRoot = liveRoot(root);
    attachRegistryRoot(registryRoot);
    // The detach is the subject here, not cleanup — afterEach's detach would
    // happen far too late to prove anything.
    detachRegistryRoot(registryRoot);

    const added = jest.fn();
    registerAttribute({ attribute: "lvt-x:copy", onElementAdded: added });

    expect(added).not.toHaveBeenCalled();
  });

  it("classifies the two layers", () => {
    const decl: AttributeHandler = { attribute: "lvt-x:a" };
    const low: AttributeHandler = { name: "b", selectors: ["[b]"], category: "always", setup: () => {} };
    expect(isDeclarative(decl)).toBe(true);
    expect(isDeclarative(low)).toBe(false);
  });
});

describe("regressions", () => {
  // Reported on PR #159. The natural declarative shape — wire on add, clean up
  // on remove — derives `wire-idempotent`, so gating the SWEEP on the category
  // meant an element that lost its attribute kept its listeners until some
  // later render happened to add a node. Worse than it first looked: the
  // morphdom hook that sets `directiveTouchedThisRender` only inspects the NEW
  // element's attributes (livetemplate-client.ts), so it detects an attribute
  // being ADDED and never one being REMOVED — the exact render this handler
  // shape cares about is the one that cannot set the flag.
  it("fires onElementRemoved on a render that added nothing", () => {
    const removed = jest.fn();
    registerAttribute({
      attribute: "lvt-x:copy",
      onElementAdded: () => {},
      onElementRemoved: removed,
    });

    const root = makeRoot(`<button lvt-x:copy="a"></button>`);
    render(root, true);
    root.firstElementChild!.removeAttribute("lvt-x:copy");

    // domChanged === false: nothing was added, and removal cannot set the flag.
    render(root, false);

    expect(removed).toHaveBeenCalledTimes(1);
  });

  it("still skips the expensive scan on a render that added nothing", () => {
    const added = jest.fn();
    registerAttribute({ attribute: "lvt-x:copy", onElementAdded: added });

    const root = makeRoot(`<button lvt-x:copy="a"></button>`);
    render(root, false);

    // The sweep is cheap and correctness-critical; the scan is the ~150-200ms
    // walk the category exists to skip. Separating them must not un-skip it.
    expect(added).not.toHaveBeenCalled();
  });

  it("keeps rendering when a low-level setup() throws", () => {
    const later = jest.fn();
    registerAttribute({
      name: "bad-setup",
      selectors: ["*"],
      setup: () => { throw new Error("boom"); },
    });
    registerAttribute({ name: "after", selectors: ["*"], setup: later });

    const root = makeRoot(`<div></div>`);
    expect(() => render(root)).not.toThrow();
    expect(later).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
  });

  it("rejects an attribute name that cannot form a valid selector", () => {
    const added = jest.fn();
    // lvtSelector escapes ':' only, so a ']' would close the attribute selector
    // early and make querySelectorAll throw on EVERY render. Registration is
    // where that has to be caught.
    registerAttribute({ attribute: "lvt-x:bad]name", onElementAdded: added });

    expect(getRegisteredAttributes()).toHaveLength(0);
    expect(warn.mock.calls.flat().join(" ")).toContain("not a usable attribute name");

    expect(() => render(makeRoot(`<div></div>`))).not.toThrow();
    expect(added).not.toHaveBeenCalled();
  });
});

describe("shapes that cannot work", () => {
  // Reported on PR #159, round 2. Elements are only tracked by the scan, and
  // the scan is skipped when there is nothing to call — so a handler declaring
  // ONLY onElementRemoved tracks nothing, sweeps nothing, and silently never
  // fires. It type-checks, because all three callbacks are optional.
  it("rejects a declarative handler that can never fire", () => {
    const removed = jest.fn();
    registerAttribute({ attribute: "lvt-x:copy", onElementRemoved: removed });

    expect(getRegisteredAttributes()).toHaveLength(0);
    expect(warn.mock.calls.flat().join(" ")).toContain("onElementRemoved");
  });

  it("rejects a declarative handler with no callbacks at all", () => {
    registerAttribute({ attribute: "lvt-x:copy" });
    expect(getRegisteredAttributes()).toHaveLength(0);
  });

  it("accepts onElementRemoved alongside a callback that can track", () => {
    registerAttribute({
      attribute: "lvt-x:copy",
      onElementAdded: () => {},
      onElementRemoved: () => {},
    });
    expect(getRegisteredAttributes()).toHaveLength(1);
  });

  it("warns once per element for a persistently empty value, not once per render", () => {
    registerAttribute({ attribute: "lvt-x:copy", onElementAdded: () => {} });

    const root = makeRoot(`<button lvt-x:copy=""></button>`);
    render(root);
    render(root);
    render(root);

    // A template that re-renders on every keystroke would otherwise emit one
    // warning per keystroke for the same element.
    const emptyWarnings = warn.mock.calls
      .flat()
      .filter((c) => typeof c === "string" && c.includes("has an empty value"));
    expect(emptyWarnings).toHaveLength(1);
  });

  it("still reports an element that heals and then empties again", () => {
    registerAttribute({ attribute: "lvt-x:copy", onElementAdded: () => {} });

    const root = makeRoot(`<button lvt-x:copy=""></button>`);
    const el = root.firstElementChild!;
    render(root);
    el.setAttribute("lvt-x:copy", "real");
    render(root);
    el.setAttribute("lvt-x:copy", "");
    render(root);

    const emptyWarnings = warn.mock.calls
      .flat()
      .filter((c) => typeof c === "string" && c.includes("has an empty value"));
    expect(emptyWarnings).toHaveLength(2);
  });
});
