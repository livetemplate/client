/**
 * RangeDomApplier Tests
 *
 * Verifies per-op targeted DOM mutation for range diff ops:
 *   r (remove), u (update), i (insert after), a (append),
 *   p (prepend), o (reorder)
 *
 * The applier bypasses full HTML reconstruction + morphdom diff for
 * the common case of single-row mutation on a large keyed range.
 */
import {
  RangeDomApplier,
  TARGETED_APPLIED_ATTR,
  TARGETED_SKIP_ATTR,
} from "../state/range-dom-applier";
import { TreeRenderer } from "../state/tree-renderer";
import { createLogger } from "../utils/logger";
import type { TargetedRangeOp } from "../types";

interface Fixture {
  wrapper: Element;
  container: Element;
  renderer: TreeRenderer;
  applier: RangeDomApplier;
  hookCalls: Array<{ hook: string; key: string | null }>;
  rangePath: string;
  statics: string[];
  itemState: Map<string, any>;
}

const ROW_STATICS = ['<tr data-key="', '"><td>', "</td></tr>"];
const RANGE_PATH = "0";

function makeFixture(itemCount: number): Fixture {
  const logger = createLogger({ level: "silent" });
  const renderer = new TreeRenderer(logger);
  const items = Array.from({ length: itemCount }, (_, i) => ({
    _k: `row-${i}`,
    "0": `row-${i}`,
    "1": `value-${i}`,
  }));
  const result = renderer.applyUpdate({
    s: ["<div><table><tbody>", "</tbody></table></div>"],
    [RANGE_PATH]: {
      d: items,
      s: ROW_STATICS,
      m: { idKey: "0" },
    },
  });

  document.body.innerHTML = result.html;
  const wrapper = document.body.firstElementChild as Element;
  const container = wrapper.querySelector("tbody") as Element;

  const itemState = new Map<string, any>();
  for (const it of items) {
    itemState.set(it._k, it);
  }

  const hookCalls: Array<{ hook: string; key: string | null }> = [];
  const applier = new RangeDomApplier({
    logger,
    renderItem: (item, idx, statics, sm, sp) =>
      renderer.renderRangeItem(item, idx, statics, sm, sp),
    executeLifecycleHook: (el, hook) => {
      hookCalls.push({ hook, key: el.getAttribute("data-key") });
    },
    itemLookup: (path, key) => {
      if (path === RANGE_PATH) return itemState.get(key);
      return undefined;
    },
  });
  // Mirror the production flow: callers run canApplyTargeted (which
  // resolves and caches the container) before calling apply. Without
  // this, a/p ops can't locate the container — they have no key in
  // op[1] for findContainer to walk to.
  if (items.length > 0) {
    applier.findContainer(wrapper, RANGE_PATH, items[0]._k);
  }

  return {
    wrapper,
    container,
    renderer,
    applier,
    hookCalls,
    rangePath: RANGE_PATH,
    statics: ROW_STATICS,
    itemState,
  };
}

function makeTargetedOp(ops: any[]): TargetedRangeOp {
  return {
    rangePath: RANGE_PATH,
    ops,
    statics: ROW_STATICS,
    idKey: "0",
  };
}

describe("RangeDomApplier - container & predicate", () => {
  it("findContainer locates the items' parent via data-key sample", () => {
    const fx = makeFixture(5);
    const c = fx.applier.findContainer(fx.wrapper, RANGE_PATH, "row-2");
    expect(c).toBe(fx.container);
  });

  it("findContainer returns null when no sample key is provided and cache empty", () => {
    const fx = makeFixture(5);
    fx.applier.invalidate();
    // No anyKnownItemKey → must NOT fall back to an unscoped wrapper walk
    // (which could return a container belonging to a different keyed range).
    expect(fx.applier.findContainer(fx.wrapper, RANGE_PATH)).toBeNull();
  });

  it("findContainer returns null when sample key doesn't match any element", () => {
    const fx = makeFixture(5);
    fx.applier.invalidate();
    expect(
      fx.applier.findContainer(fx.wrapper, RANGE_PATH, "ghost-key")
    ).toBeNull();
  });

  it("findContainer re-resolves when cached element detaches", () => {
    const fx = makeFixture(5);
    fx.applier.findContainer(fx.wrapper, RANGE_PATH, "row-2");
    fx.container.remove();
    expect(fx.applier.findContainer(fx.wrapper, RANGE_PATH, "row-2")).toBeNull();
  });

  it("canApplyTargeted ok for keyed range with no nested ranges", () => {
    const fx = makeFixture(5);
    const result = fx.applier.canApplyTargeted(
      fx.wrapper,
      { d: [...fx.itemState.values()], s: ROW_STATICS, m: { idKey: "0" } },
      RANGE_PATH
    );
    expect(result.ok).toBe(true);
    expect(result.container).toBe(fx.container);
  });

  it("canApplyTargeted rejects when statics lack data-key", () => {
    const fx = makeFixture(5);
    const result = fx.applier.canApplyTargeted(
      fx.wrapper,
      {
        d: [{ _k: "x", "0": "a" }],
        s: ["<li>", "</li>"],
      },
      RANGE_PATH
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/data-key/);
  });

  it("canApplyTargeted rejects nested-range items", () => {
    const fx = makeFixture(5);
    const result = fx.applier.canApplyTargeted(
      fx.wrapper,
      {
        d: [
          {
            _k: "row-0",
            "0": "row-0",
            "1": { d: [{ "0": "nested" }], s: ["<i>", "</i>"] },
          },
        ],
        s: ROW_STATICS,
      },
      RANGE_PATH
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/nested-range/);
  });

  it("canApplyTargeted rejects when lvt-ignore is on the wrapper path", () => {
    const fx = makeFixture(5);
    const tableEl = fx.wrapper.querySelector("table")!;
    tableEl.setAttribute("lvt-ignore", "");
    const result = fx.applier.canApplyTargeted(
      fx.wrapper,
      { d: [...fx.itemState.values()], s: ROW_STATICS, m: { idKey: "0" } },
      RANGE_PATH
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/lvt-ignore/);
  });

  it("canApplyTargeted rejects when lvt-ignore is on the wrapper element itself", () => {
    const fx = makeFixture(5);
    fx.wrapper.setAttribute("lvt-ignore", "");
    const result = fx.applier.canApplyTargeted(
      fx.wrapper,
      { d: [...fx.itemState.values()], s: ROW_STATICS, m: { idKey: "0" } },
      RANGE_PATH
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/lvt-ignore/);
  });
});

describe("RangeDomApplier - r (remove)", () => {
  it("removes a row by key", () => {
    const fx = makeFixture(5);
    expect(fx.container.querySelectorAll("tr").length).toBe(5);
    fx.applier.apply(fx.wrapper, makeTargetedOp([["r", "row-2"]]));
    expect(fx.container.querySelectorAll("tr").length).toBe(4);
    expect(fx.container.querySelector('[data-key="row-2"]')).toBeNull();
  });

  it("fires lvt-destroyed on the row before removal", () => {
    const fx = makeFixture(3);
    fx.container.querySelector('[data-key="row-1"]')!.setAttribute(
      "lvt-destroyed",
      "/* hook */"
    );
    fx.applier.apply(fx.wrapper, makeTargetedOp([["r", "row-1"]]));
    expect(fx.hookCalls).toEqual([
      { hook: "lvt-destroyed", key: "row-1" },
    ]);
  });

  it("fires lvt-destroyed on descendants too", () => {
    const fx = makeFixture(3);
    const row = fx.container.querySelector('[data-key="row-0"]')!;
    const td = row.querySelector("td")!;
    td.setAttribute("lvt-destroyed", "/* hook */");
    fx.applier.apply(fx.wrapper, makeTargetedOp([["r", "row-0"]]));
    expect(
      fx.hookCalls.some((c) => c.hook === "lvt-destroyed" && c.key === null)
    ).toBe(true);
  });

  it("is a no-op when key is missing (logs debug)", () => {
    const fx = makeFixture(3);
    expect(() =>
      fx.applier.apply(fx.wrapper, makeTargetedOp([["r", "missing-key"]]))
    ).not.toThrow();
    expect(fx.container.querySelectorAll("tr").length).toBe(3);
  });
});

describe("RangeDomApplier - u (update)", () => {
  it("updates a single row in place", () => {
    const fx = makeFixture(3);
    fx.itemState.set("row-1", {
      _k: "row-1",
      "0": "row-1",
      "1": "updated-value",
    });
    fx.applier.apply(
      fx.wrapper,
      makeTargetedOp([["u", "row-1", { "1": "updated-value" }]])
    );
    const row = fx.container.querySelector('[data-key="row-1"]')!;
    expect(row.textContent).toContain("updated-value");
    expect(fx.container.querySelectorAll("tr").length).toBe(3);
  });

  it("fires lvt-destroyed/lvt-mounted when called without morphdomOptions", () => {
    const fx = makeFixture(3);
    const oldRow = fx.container.querySelector(
      '[data-key="row-1"]'
    ) as Element;
    oldRow.setAttribute("lvt-destroyed", "/* d */");
    fx.itemState.set("row-1", {
      _k: "row-1",
      "0": "row-1",
      "1": "v1-updated",
    });
    // Override renderItem to return HTML with lvt-mounted on the row.
    const ctx = (fx.applier as any).ctx;
    const origRender = ctx.renderItem;
    ctx.renderItem = () =>
      '<tr data-key="row-1" lvt-mounted="/* m */"><td>v1-updated</td></tr>';
    // Reset hookCalls and count manual onNodeAdded notifications.
    fx.hookCalls.length = 0;
    let nodeAddedCalls = 0;
    ctx.onNodeAdded = () => {
      nodeAddedCalls++;
    };
    // Call apply WITHOUT passing morphdomOptions (third arg).
    fx.applier.apply(
      fx.wrapper,
      makeTargetedOp([["u", "row-1", { "1": "v1-updated" }]])
    );
    // Restore.
    ctx.renderItem = origRender;
    ctx.onNodeAdded = undefined;

    // Both lifecycle hooks fired AND the host was notified about the new node.
    expect(
      fx.hookCalls.find((c) => c.hook === "lvt-destroyed")
    ).toBeDefined();
    expect(
      fx.hookCalls.find((c) => c.hook === "lvt-mounted")
    ).toBeDefined();
    expect(nodeAddedCalls).toBe(1);
  });

  it("morphs the row with childrenOnly:false so root-element attrs are diffed", async () => {
    // Row attribute (class) changes between renders. With childrenOnly:true
    // morphdom would skip attr diffing on the row root. Verify we override
    // and the class makes it onto the live element.
    const morphdom = (await import("morphdom")).default;
    const fx = makeFixture(2);
    fx.itemState.set("row-0", {
      _k: "row-0",
      "0": "row-0",
      "1": "v0",
    });
    const ctx = (fx.applier as any).ctx;
    const origRender = ctx.renderItem;
    ctx.renderItem = () =>
      '<tr data-key="row-0" class="highlighted"><td>v0</td></tr>';

    const morphdomOpts = { childrenOnly: true }; // intentionally provoke the bug
    fx.applier.apply(
      fx.wrapper,
      makeTargetedOp([["u", "row-0", { "1": "v0" }]]),
      morphdomOpts
    );
    ctx.renderItem = origRender;

    // The row root's class attribute should now be "highlighted" — only
    // possible if the applier overrode childrenOnly to false.
    const row = fx.container.querySelector('[data-key="row-0"]')!;
    expect(row.getAttribute("class")).toBe("highlighted");
    // morphdom is referenced just to ensure the import path stays alive
    void morphdom;
  });

  it("returns null from apply() when u op silently no-ops (item state missing)", () => {
    // Stale state: item is in DOM but lookup returns nothing. Previously,
    // applyUpdateRow would log + return silently and apply() would still
    // mark the container as TARGETED_APPLIED → morphdom skips → live DOM
    // stays out of sync forever. With the boolean-return fix, apply()
    // returns null and updateDOM falls back to a full rebuild.
    const fx = makeFixture(3);
    fx.itemState.delete("row-1"); // simulate desync
    const result = fx.applier.apply(
      fx.wrapper,
      makeTargetedOp([["u", "row-1", { "1": "v1-new" }]])
    );
    expect(result).toBeNull();
  });

  it("returns null from apply() when i op anchor is missing", () => {
    const fx = makeFixture(3);
    const result = fx.applier.apply(
      fx.wrapper,
      makeTargetedOp([["i", "ghost-anchor", { _k: "row-new" }]])
    );
    expect(result).toBeNull();
  });

  it("r op is idempotent (apply succeeds even when row already gone)", () => {
    const fx = makeFixture(3);
    fx.container.querySelector('[data-key="row-1"]')!.remove();
    const result = fx.applier.apply(
      fx.wrapper,
      makeTargetedOp([["r", "row-1"]])
    );
    expect(result).toBe(fx.container);
  });

  it("preserves focus on an input inside the updated row when morphdomOptions provided", () => {
    const fx = makeFixture(3);
    const formStatics = [
      '<tr data-key="',
      '"><td><input name="',
      '" value="',
      '" /></td></tr>',
    ];
    const items = [
      { _k: "row-0", "0": "row-0", "1": "name0", "2": "v0" },
      { _k: "row-1", "0": "row-1", "1": "name1", "2": "v1" },
    ];
    const reslt = fx.renderer.applyUpdate({
      s: ["<div><table><tbody>", "</tbody></table></div>"],
      [RANGE_PATH]: { d: items, s: formStatics, m: { idKey: "0" } },
    });
    document.body.innerHTML = reslt.html;
    const wrapper = document.body.firstElementChild as Element;
    const container = wrapper.querySelector("tbody") as Element;
    fx.applier.invalidate();
    fx.itemState.clear();
    for (const it of items) fx.itemState.set(it._k, it);
    fx.itemState.set("row-1", {
      _k: "row-1",
      "0": "row-1",
      "1": "name1",
      "2": "v1-updated",
    });

    const input = container.querySelector(
      '[data-key="row-1"] input'
    ) as HTMLInputElement;
    input.focus();
    expect(document.activeElement).toBe(input);

    const morphdomOpts = {
      childrenOnly: false,
      onBeforeElUpdated: (fromEl: any, toEl: any) => {
        if (fromEl === input) {
          for (const a of Array.from(toEl.attributes)) {
            const attr = a as Attr;
            if (attr.name !== "value") {
              fromEl.setAttribute(attr.name, attr.value);
            }
          }
          return false;
        }
        return true;
      },
    };

    fx.applier.apply(
      wrapper,
      {
        rangePath: RANGE_PATH,
        ops: [["u", "row-1", { "2": "v1-updated" }]],
        statics: formStatics,
        idKey: "0",
      },
      morphdomOpts
    );

    expect(document.activeElement).toBe(input);
  });
});

describe("RangeDomApplier - i (insert after)", () => {
  it("inserts a single new row after the anchor", () => {
    const fx = makeFixture(3);
    const newItem = { _k: "row-new", "0": "row-new", "1": "val-new" };
    fx.itemState.set("row-new", newItem);
    fx.applier.apply(
      fx.wrapper,
      makeTargetedOp([["i", "row-1", newItem]])
    );
    const rows = Array.from(fx.container.querySelectorAll("tr"));
    expect(rows.length).toBe(4);
    expect(rows[2].getAttribute("data-key")).toBe("row-new");
  });

  it("fires lvt-mounted on the inserted row + descendants", () => {
    const fx = makeFixture(3);
    const itemHtml = `<tr data-key="row-new" lvt-mounted="/* */"><td lvt-mounted="/* */">val-new</td></tr>`;
    const ctx = (fx.applier as any).ctx;
    ctx.renderItem = () => itemHtml;
    fx.applier.apply(
      fx.wrapper,
      makeTargetedOp([["i", "row-1", { _k: "row-new" }]])
    );
    expect(fx.hookCalls.filter((c) => c.hook === "lvt-mounted").length).toBe(2);
  });
});

describe("RangeDomApplier - a (append)", () => {
  it("appends rows to the end", () => {
    const fx = makeFixture(2);
    const items = [
      { _k: "row-a", "0": "row-a", "1": "va" },
      { _k: "row-b", "0": "row-b", "1": "vb" },
    ];
    items.forEach((it) => fx.itemState.set(it._k, it));
    fx.applier.apply(fx.wrapper, makeTargetedOp([["a", items]]));
    const rows = Array.from(fx.container.querySelectorAll("tr"));
    expect(rows.length).toBe(4);
    expect(rows[2].getAttribute("data-key")).toBe("row-a");
    expect(rows[3].getAttribute("data-key")).toBe("row-b");
  });
});

describe("RangeDomApplier - p (prepend)", () => {
  it("prepends rows to the start", () => {
    const fx = makeFixture(2);
    const items = [
      { _k: "row-x", "0": "row-x", "1": "vx" },
      { _k: "row-y", "0": "row-y", "1": "vy" },
    ];
    items.forEach((it) => fx.itemState.set(it._k, it));
    fx.applier.apply(fx.wrapper, makeTargetedOp([["p", items]]));
    const rows = Array.from(fx.container.querySelectorAll("tr"));
    expect(rows.length).toBe(4);
    expect(rows[0].getAttribute("data-key")).toBe("row-x");
    expect(rows[1].getAttribute("data-key")).toBe("row-y");
  });
});

describe("RangeDomApplier - o (reorder)", () => {
  it("reorders existing rows in-place via DocumentFragment", () => {
    const fx = makeFixture(4);
    const beforeRefs = Array.from(fx.container.children);
    fx.applier.apply(
      fx.wrapper,
      makeTargetedOp([["o", ["row-3", "row-1", "row-0", "row-2"]]])
    );
    const after = Array.from(fx.container.children);
    expect(after.map((r) => r.getAttribute("data-key"))).toEqual([
      "row-3",
      "row-1",
      "row-0",
      "row-2",
    ]);
    // Same element identities — no re-creation
    expect(after.every((el) => beforeRefs.includes(el))).toBe(true);
  });

  it("ignores keys not present in the container", () => {
    const fx = makeFixture(3);
    fx.applier.apply(
      fx.wrapper,
      makeTargetedOp([["o", ["row-2", "ghost", "row-0", "row-1"]]])
    );
    const after = Array.from(fx.container.children).map((r) =>
      r.getAttribute("data-key")
    );
    expect(after).toEqual(["row-2", "row-0", "row-1"]);
  });

  it("fires lvt-destroyed on dropped children (partial newKeyOrder)", () => {
    const fx = makeFixture(4);
    // Tag two of the rows with lvt-destroyed so we can assert hooks fire.
    fx.container
      .querySelector('[data-key="row-1"]')!
      .setAttribute("lvt-destroyed", "/* hook1 */");
    fx.container
      .querySelector('[data-key="row-3"]')!
      .setAttribute("lvt-destroyed", "/* hook3 */");
    fx.hookCalls.length = 0;
    // newKeyOrder excludes row-1 and row-3 → both should be destroyed.
    fx.applier.apply(
      fx.wrapper,
      makeTargetedOp([["o", ["row-2", "row-0"]]])
    );
    const destroyedKeys = fx.hookCalls
      .filter((c) => c.hook === "lvt-destroyed")
      .map((c) => c.key)
      .sort();
    expect(destroyedKeys).toEqual(["row-1", "row-3"]);
    const after = Array.from(fx.container.children).map((r) =>
      r.getAttribute("data-key")
    );
    expect(after).toEqual(["row-2", "row-0"]);
  });
});

describe("RangeDomApplier - skip mechanism with morphdom", () => {
  it("morphdom preserves the live container's children when skip marker present", async () => {
    const morphdom = (await import("morphdom")).default;
    const fx = makeFixture(50);

    // Snapshot row identities before any change
    fx.itemState.delete("row-25");
    fx.applier.apply(fx.wrapper, makeTargetedOp([["r", "row-25"]]));
    fx.container.setAttribute(TARGETED_APPLIED_ATTR, "");
    const liveRowsAfterApply = Array.from(fx.container.children);
    expect(liveRowsAfterApply.length).toBe(49);

    // Build a tempWrapper that mimics what reconstructFromTree+placeholder
    // produces: the rebuilt container is empty + tagged with the skip marker.
    const tempWrapper = document.createElement(fx.wrapper.tagName);
    tempWrapper.innerHTML =
      "<table><tbody data-lvt-targeted-skip=\"0\"></tbody></table>";

    let beforeElUpdatedCallsInRange = 0;
    morphdom(fx.wrapper, tempWrapper, {
      childrenOnly: true,
      getNodeKey: (node: any) => {
        if (node.nodeType === 1) {
          return (
            node.getAttribute("data-key") ||
            node.getAttribute("data-lvt-key") ||
            undefined
          );
        }
      },
      onBeforeElUpdated: (fromEl: any, toEl: any) => {
        if (
          toEl.nodeType === Node.ELEMENT_NODE &&
          (toEl as Element).hasAttribute(TARGETED_SKIP_ATTR)
        ) {
          return false;
        }
        if (
          fromEl.nodeType === 1 &&
          (fromEl as Element).hasAttribute("data-key")
        ) {
          beforeElUpdatedCallsInRange++;
        }
        return true;
      },
    });

    // Children survived intact — morphdom did NOT remove them despite
    // toEl having an empty container.
    const liveRowsAfterMorph = Array.from(fx.container.children);
    expect(liveRowsAfterMorph.length).toBe(49);
    // Same element identities — no replacement, no rebuild.
    expect(
      liveRowsAfterMorph.every((row, i) => row === liveRowsAfterApply[i])
    ).toBe(true);
    // Critical: morphdom never invoked onBeforeElUpdated on any of the
    // 49 keyed rows — the subtree was short-circuited. This is the
    // savings vs. the full-rebuild path (which would call it 49 times,
    // each with attribute diffing + descendant walk).
    expect(beforeElUpdatedCallsInRange).toBe(0);
  });
});

describe("RangeDomApplier - cleanupMarkers", () => {
  it("strips both data-lvt-targeted-applied and data-lvt-targeted-skip", () => {
    const fx = makeFixture(2);
    fx.container.setAttribute(TARGETED_APPLIED_ATTR, "");
    fx.container.setAttribute(TARGETED_SKIP_ATTR, "8");
    fx.applier.cleanupMarkers(fx.wrapper);
    expect(fx.container.hasAttribute(TARGETED_APPLIED_ATTR)).toBe(false);
    expect(fx.container.hasAttribute(TARGETED_SKIP_ATTR)).toBe(false);
  });

  it("strips marker even when set on the wrapper itself", () => {
    const fx = makeFixture(1);
    fx.wrapper.setAttribute(TARGETED_APPLIED_ATTR, "");
    fx.applier.cleanupMarkers(fx.wrapper);
    expect(fx.wrapper.hasAttribute(TARGETED_APPLIED_ATTR)).toBe(false);
  });
});
