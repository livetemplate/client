/**
 * The built-in handler registration list.
 *
 * WHY THIS EXISTS, since every built-in already has its own behavioural suite:
 * those suites call the handler FUNCTIONS directly (`handleScrollDirectives`,
 * `setupSpy`, …), which is what made them a clean regression net for the
 * registry migration — the functions did not change. The cost of that property
 * is that they cannot see the wiring at all. A registration list that silently
 * lost fourteen of its eighteen entries left all 851 of them green, and only
 * the bundle size gave it away.
 *
 * So this file asserts the wiring itself: the exact set, and the exact order.
 */

import { registerBuiltinHandlers } from "../dom/builtin-handlers";
import {
  getRegisteredAttributes,
  isDeclarative,
  resolveCategory,
  __resetRegistryForTesting,
} from "../attribute-registry";

/**
 * The order the hardcoded post-render sequence called these in. Order is
 * preserved rather than asserted to matter (see the module header), but it is
 * pinned so that a change to it is a deliberate edit to this list rather than a
 * side effect of moving code around.
 */
const EXPECTED_ORDER = [
  "lvt-fx:scroll",
  "lvt-fx:highlight",
  "lvt-fx:animate",
  "lvt-toast-stack",
  "lvt-fx:auto-click",
  "lvt-fx:area-select",
  "lvt-fx:resize",
  "lvt-fx:region-select",
  "lvt-fx:text-select",
  "lvt-fx:viewport-report",
  "lvt-fx:proxy-bridge",
  "lvt-fx:iframe-autoheight",
  "lvt-fx:preview-bridge",
  "lvt-fx:url-hash",
  "shadow-root-hydration",
  "lvt-scroll-away",
  "lvt-spy",
  "lvt-fx:*:on:*",
];

/** The six handlers that dispatch server actions. */
const SERVER_CHANNEL = [
  "lvt-fx:area-select",
  "lvt-fx:region-select",
  "lvt-fx:text-select",
  "lvt-fx:viewport-report",
  "lvt-fx:proxy-bridge",
  "lvt-fx:url-hash",
];

beforeEach(() => {
  __resetRegistryForTesting();
  registerBuiltinHandlers();
});

afterEach(() => {
  __resetRegistryForTesting();
});

describe("built-in registration", () => {
  it("registers every built-in, in the historic call order", () => {
    expect(getRegisteredAttributes().map((h) => h.name)).toEqual(EXPECTED_ORDER);
  });

  it("gives every built-in a setup function and a claimable name", () => {
    for (const handler of getRegisteredAttributes()) {
      expect(handler.name).toBeTruthy();
      expect(isDeclarative(handler)).toBe(false);
      expect(typeof (handler as any).setup).toBe("function");
    }
  });

  it("grants the server channel to exactly the handlers that dispatch actions", () => {
    const withChannel = getRegisteredAttributes()
      .filter((h) => h.needsServerChannel)
      .map((h) => h.name);
    expect(withChannel.sort()).toEqual([...SERVER_CHANNEL].sort());
  });

  it("keeps only the descendant walker on the wire-idempotent skip", () => {
    // Everything else must run on every render: they react to a value changing
    // on an element that already exists, which a skip would swallow.
    const skippable = getRegisteredAttributes()
      .filter((h) => resolveCategory(h) === "wire-idempotent")
      .map((h) => h.name);
    expect(skippable).toEqual(["lvt-fx:*:on:*"]);
  });

  it("registers no two handlers claiming the same name", () => {
    const names = getRegisteredAttributes().map((h) => h.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("declares root-less cleanup only where teardown(root) cannot express it", () => {
    const disposers = getRegisteredAttributes()
      .filter((h) => h.dispose)
      .map((h) => h.name);
    // auto-click arms module-global timers, so there is no root to scope them to.
    expect(disposers).toEqual(["lvt-fx:auto-click"]);
  });

  it("is idempotent enough to warn rather than silently double-register", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    registerBuiltinHandlers();
    expect(warn.mock.calls.flat().join(" ")).toContain("already claims this name");
    warn.mockRestore();
  });
});
