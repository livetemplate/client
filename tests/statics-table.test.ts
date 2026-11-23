/**
 * Statics table: livetemplate may send each statics array that repeats within a
 * message once, in a top-level "S", and write "s": <index> where it repeats.
 */
import { expandStaticsTable } from "../state/statics-table";
import { TreeRenderer } from "../state/tree-renderer";
import { createLogger } from "../utils/logger";

const row = ['<div class="line-row">', "</div>"];

describe("expandStaticsTable", () => {
  it("replaces every index with its array at any depth and drops S", () => {
    const tree: any = {
      S: [row, ["<p>", "</p>"]],
      s: ["<main>", "</main>"],
      "0": {
        d: [
          { "0": { "0": "a", s: 0 } },
          { "0": { "0": "b", s: 0 } },
        ],
        s: ["", ""],
      },
      "1": [["u", "k1", { "2": { "0": "x", s: 1 } }]],
    };
    expandStaticsTable(tree);
    expect(tree.S).toBeUndefined();
    expect(tree["0"].d[0]["0"].s).toEqual(row);
    expect(tree["0"].d[1]["0"].s).toEqual(row);
    expect(tree["1"][0][2]["2"].s).toEqual(["<p>", "</p>"]);
    expect(tree.s).toEqual(["<main>", "</main>"]);
  });

  it("leaves a tree without S untouched, and expanding twice is a no-op", () => {
    const plain: any = { "0": { s: row, "0": "a" } };
    const before = JSON.stringify(plain);
    expandStaticsTable(plain);
    expect(JSON.stringify(plain)).toBe(before);
    const table: any = { S: [row], "0": { s: 0, "0": "a" } };
    expandStaticsTable(table);
    const once = JSON.stringify(table);
    expandStaticsTable(table);
    expect(JSON.stringify(table)).toBe(once);
    expect(() => expandStaticsTable(undefined)).not.toThrow();
  });

  it("throws on an index the table doesn't have, and keeps the table", () => {
    const bad = { S: [row], "0": { s: 3 } } as any;
    expect(() => expandStaticsTable(bad)).toThrow("statics table has no entry 3");
    expect(bad.S).toEqual([row]);
  });

  it("drops a table that no node points at", () => {
    const tree = { S: [row], s: ["<p>", "</p>"], "0": "x" } as any;
    expandStaticsTable(tree);
    expect(tree).toEqual({ s: ["<p>", "</p>"], "0": "x" });
  });
});

describe("TreeRenderer with a statics table", () => {
  const items = (statics: any) => [
    { "0": "k1", "1": { "0": "one", s: statics } },
    { "0": "k2", "1": { "0": "two", s: statics } },
  ];
  const rangeStatics = ['<li data-key="', '">', "</li>"];

  it("renders the same HTML as the expanded tree, before and after an update", () => {
    const withTable = new TreeRenderer(createLogger({ scope: "t" }));
    const expanded = new TreeRenderer(createLogger({ scope: "t" }));
    const first = (s: any, table?: any[]) => ({
      ...(table ? { S: table } : {}),
      s: ["<ul>", "</ul>"],
      "0": { d: items(s), s: rangeStatics },
    });
    const a = withTable.applyUpdate(first(0, [row]) as any);
    const b = expanded.applyUpdate(first(row) as any);
    expect(a.html).toBe(b.html);
    expect(a.html).toContain('class="line-row"');

    // A later update whose new item carries its statics through the table.
    const update = (s: any, table?: any[]) => ({
      ...(table ? { S: table } : {}),
      "0": [["a", [{ "0": "k3", "1": { "0": "three", s } }]]],
    });
    expect(withTable.applyUpdate(update(0, [row]) as any).html).toBe(
      expanded.applyUpdate(update(row) as any).html
    );
  });
});
