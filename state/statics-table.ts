import type { TreeNode } from "../types";

/**
 * Resolves a message's statics table (tree-update spec §2.5) in place: every
 * `"s": <index>` becomes its array from the top-level `"S"`, and `"S"` is
 * removed. A tree without `"S"` is untouched, so calling it twice is a no-op.
 */
export function expandStaticsTable(tree: TreeNode | undefined): void {
  const root = tree as Record<string, unknown> | undefined;
  const table = root?.S;
  if (!root || !Array.isArray(table)) {
    return;
  }
  delete root.S;

  const walk = (value: object): void => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry && typeof entry === "object") {
          walk(entry);
        }
      }
      return;
    }
    const node = value as Record<string, unknown>;
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (key === "s") {
        if (typeof child === "number") {
          const statics = table[child];
          if (!Array.isArray(statics)) {
            throw new Error(`statics table has no entry ${child}`);
          }
          node.s = statics;
        }
      } else if (child && typeof child === "object") {
        walk(child);
      }
    }
  };
  walk(root);
}
