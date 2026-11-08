/**
 * The attribute census diff — Phase 2's client half of livetemplate#473.
 *
 * The server sends `meta.attributes` with every lvt-* name the template uses,
 * in the AUTHORED spelling; the client warns once per name nothing claims.
 * These tests feed it payloads shaped exactly like the Go side emits.
 */

import {
  CORE_CLAIMS,
  isClaimed,
  reportUnclaimedAttributes,
  __resetCensusForTesting,
} from "../attribute-census";
import {
  registerAttribute,
  registeredClaims,
  __resetRegistryForTesting,
  type AttributeHandler,
} from "../attribute-registry";
import {
  registerBuiltinHandlers,
  __resetBuiltinRegistrationForTesting,
} from "../dom/builtin-handlers";

/**
 * Every legitimate name the server census reported across the docs, lvt,
 * prereview and checklistkit template corpus (2026-11-08), authored spelling.
 * A page using all of them must warn about none.
 */
const REAL_CORPUS = [
  "lvt-autofocus",
  "lvt-debounce",
  "lvt-el:addClass",
  "lvt-el:removeClass",
  "lvt-el:reset",
  "lvt-el:setAttr",
  "lvt-el:toggleAttr",
  "lvt-el:toggleClass",
  "lvt-focus-trap",
  "lvt-form:action",
  "lvt-form:disable-with",
  "lvt-form:no-intercept",
  "lvt-form:preserve",
  "lvt-fx:animate",
  "lvt-fx:area-select",
  "lvt-fx:auto-click",
  "lvt-fx:highlight",
  "lvt-fx:preview-bridge",
  "lvt-fx:proxy-bridge",
  "lvt-fx:region-select",
  "lvt-fx:resize",
  "lvt-fx:scroll",
  "lvt-fx:text-select",
  "lvt-fx:url-hash",
  "lvt-fx:viewport-report",
  "lvt-ignore",
  "lvt-ignore-attrs",
  "lvt-key",
  "lvt-mod:debounce",
  "lvt-mod:skip-when-typing",
  "lvt-mod:throttle",
  "lvt-nav:no-intercept",
  "lvt-on:click",
  "lvt-on:click-away",
  "lvt-on:window:keydown",
  "lvt-persist",
  "lvt-scroll-away",
  "lvt-scroll-sentinel",
  "lvt-spy",
  "lvt-spy-link",
  "lvt-upload",
  "lvt-upload-with",
];

/** Mirrors the client's instance-bound upload handler, which is not in the module registry. */
const uploadHandler: AttributeHandler = {
  name: "lvt-upload",
  selectors: ['input[type="file"][lvt-upload]'],
  claims: ["lvt-upload", "lvt-upload-with"],
  setup: () => {},
};
const instanceHandlers = [uploadHandler];

let warn: jest.SpyInstance;

function warnings(): string[] {
  return warn.mock.calls.map((args) => args.join(" "));
}

beforeEach(() => {
  __resetRegistryForTesting();
  __resetBuiltinRegistrationForTesting();
  __resetCensusForTesting();
  registerBuiltinHandlers();
  warn = jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  __resetRegistryForTesting();
});

describe("attribute census", () => {
  it("warns about nothing for the real template corpus", () => {
    reportUnclaimedAttributes(REAL_CORPUS, instanceHandlers);
    expect(warnings()).toEqual([]);
  });

  it("folds case: the server's authored lvt-el:addClass is claimed", () => {
    reportUnclaimedAttributes(["lvt-el:addClass", "LVT-FX:Scroll"], instanceHandlers);
    expect(warnings()).toEqual([]);
  });

  it("claims a whole namespace by prefix", () => {
    reportUnclaimedAttributes(["lvt-on:my-widget-change", "lvt-mod:anything"], instanceHandlers);
    expect(warnings()).toEqual([]);
  });

  it("does not let a prefix claim match a longer exact name", () => {
    expect(isClaimed("lvt-keyboard", CORE_CLAIMS)).toBe(false);
    expect(isClaimed("lvt-key", CORE_CLAIMS)).toBe(true);
  });

  it("warns exactly once for an unknown attribute, naming the authored spelling", () => {
    reportUnclaimedAttributes(["lvt-x:Nope", "lvt-on:click"], instanceHandlers);
    reportUnclaimedAttributes(["lvt-x:nope"], instanceHandlers);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain("lvt-x:Nope");
  });

  it("warns for an lvt-fx: effect nothing implements", () => {
    // The server reports lvt-fx:highlight:on:click as lvt-fx:highlight (it
    // collapses at ":on:"), so a real effect is claimed by its own handler and
    // an invented one is not — the namespace is deliberately not a prefix claim.
    reportUnclaimedAttributes(["lvt-fx:highlight", "lvt-fx:bogus"], instanceHandlers);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain("lvt-fx:bogus");
  });

  it("warns for dead attributes still present in real templates", () => {
    reportUnclaimedAttributes(["lvt-click", "lvt-change", "lvt-data-id"], instanceHandlers);
    expect(warnings()).toHaveLength(3);
  });

  it("starts warning for a built-in's names once that handler is not registered", () => {
    // The Phase 4 case: a handler moved to another bundle that did not load.
    // Its claim must leave with it, or the warning could never fire.
    expect(registeredClaims()).toContain("lvt-fx:url-hash");
    __resetRegistryForTesting();
    reportUnclaimedAttributes(["lvt-fx:url-hash", "lvt-on:click"], instanceHandlers);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain("lvt-fx:url-hash");
  });

  it("counts a declarative handler's attribute as its claim", () => {
    registerAttribute({ attribute: "lvt-x:copy", onElementAdded: () => {} });
    reportUnclaimedAttributes(["lvt-x:copy"], instanceHandlers);
    expect(warnings()).toEqual([]);
  });

  it("waits for window load, so a handler registered by then is not reported", () => {
    const readyState = jest.spyOn(document, "readyState", "get").mockReturnValue("interactive");
    try {
      reportUnclaimedAttributes(["lvt-x:late"], instanceHandlers);
      registerAttribute({ attribute: "lvt-x:late", onElementAdded: () => {} });
      window.dispatchEvent(new Event("load"));
      expect(warnings()).toEqual([]);
    } finally {
      readyState.mockRestore();
    }
  });

  it("still reports after load when nothing registered in the meantime", () => {
    const readyState = jest.spyOn(document, "readyState", "get").mockReturnValue("interactive");
    try {
      reportUnclaimedAttributes(["lvt-x:missing"], instanceHandlers);
      expect(warnings()).toEqual([]);
      window.dispatchEvent(new Event("load"));
      expect(warnings()).toHaveLength(1);
    } finally {
      readyState.mockRestore();
    }
  });
});
