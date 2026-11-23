import type { TreeNode } from "../types";

/**
 * Expands a message's statics table. livetemplate may send each statics array
 * that repeats within one message once, in a top-level `"S"` table, and write
 * `"s": <index>` wherever it would repeat. This replaces every index with its
 * array, in place, and removes `"S"`, so the rest of the client only ever sees
 * arrays. Nodes then share one array; nothing in the client mutates statics in
 * place, so that is safe.
 *
 * The table lives for one message only: there is nothing to keep across
 * updates. A tree without `"S"` is returned untouched, and expanding twice is a
 * no-op, so callers can expand wherever a tree enters.
 */
export function expandStaticsTable<T extends TreeNode | undefined>(tree: T): T {
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) {
    return tree;
  }
  const table = (tree as Record<string, unknown>).S;
  if (!Array.isArray(table)) {
    return tree;
  }
  delete (tree as Record<string, unknown>).S;

  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        walk(entry);
      }
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    const node = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(node)) {
      if (key === "s" && typeof child === "number") {
        const statics = table[child];
        if (!Array.isArray(statics)) {
          throw new Error(`statics table has no entry ${child}`);
        }
        node.s = statics;
      } else {
        walk(child);
      }
    }
  };
  walk(tree);
  return tree;
}
