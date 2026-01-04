import type { TreeNode, UpdateResult } from "../types";
import type { Logger } from "../utils/logger";

interface RangeStateEntry {
  items: any[];
  statics: any[];
  staticsMap?: Record<string, string[]>;
}

/**
 * Deep clone an object. Uses structuredClone if available (Node 17+, modern browsers),
 * falls back to JSON.parse/stringify for older environments.
 */
function deepClone<T>(obj: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(obj);
  }
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Checks if a node is a valid range structure.
 *
 * A "range" in LiveTemplate represents a {{range .Items}}...{{end}} construct.
 * It has:
 * - `d` (dynamics): Array of rendered items
 * - `s` (statics): Array of static HTML fragments between dynamic slots
 *
 * A "non-range" is any other tree node (e.g., an {{else}} clause with simple content).
 *
 * @param node - The tree node to check
 * @returns true if the node has both `d` and `s` arrays (valid range structure)
 */
function isRangeNode(node: any): boolean {
  return (
    node != null &&
    typeof node === "object" &&
    Array.isArray(node.d) &&
    Array.isArray(node.s)
  );
}

/**
 * Handles tree state management and HTML reconstruction logic for LiveTemplate.
 */
export class TreeRenderer {
  private treeState: TreeNode = {};
  private rangeState: Record<string, RangeStateEntry> = {};
  private rangeIdKeys: Record<string, string> = {};

  constructor(private readonly logger: Logger) {}

  applyUpdate(update: TreeNode): UpdateResult {
    let changed = false;

    for (const [key, value] of Object.entries(update)) {
      const isDifferentialOps =
        Array.isArray(value) &&
        value.length > 0 &&
        Array.isArray(value[0]) &&
        typeof value[0][0] === "string";

      if (isDifferentialOps) {
        // Check if there's an existing range structure to apply operations to
        const existing = this.treeState[key];
        const existingIsRange =
          existing &&
          typeof existing === "object" &&
          !Array.isArray(existing) &&
          Array.isArray(existing.d) &&
          Array.isArray(existing.s);

        if (existingIsRange) {
          // Apply differential operations to existing range structure
          this.treeState[key] = deepClone(existing);
          this.applyDifferentialOpsToRange(this.treeState[key], value, key);
        } else {
          // No existing range, store operations directly (will use rangeState later)
          this.treeState[key] = value;
        }
        changed = true;
      } else {
        const oldValue = this.treeState[key];
        const newValue =
          typeof value === "object" && value !== null && !Array.isArray(value)
            ? this.deepMergeTreeNodes(oldValue, value, key)
            : value;

        if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
          this.treeState[key] = newValue;
          changed = true;
        }
      }
    }

    const html = this.reconstructFromTree(this.treeState, "");
    return { html, changed };
  }

  reset(): void {
    this.treeState = {};
    this.rangeState = {};
    this.rangeIdKeys = {};
  }

  getTreeState(): TreeNode {
    return { ...this.treeState };
  }

  getStaticStructure(): string[] | null {
    return this.treeState.s || null;
  }

  private deepMergeTreeNodes(
    existing: any,
    update: any,
    currentPath: string = ""
  ): any {
    if (
      typeof update !== "object" ||
      update === null ||
      Array.isArray(update)
    ) {
      return update;
    }

    if (
      typeof existing !== "object" ||
      existing === null ||
      Array.isArray(existing)
    ) {
      return update;
    }

    // Detect range→non-range transition: when existing has a range structure
    // but update does NOT, we must do a full replacement instead of merge.
    // Otherwise, the old range items would be preserved and rendered with
    // the new (else clause) statics, causing wrong content.
    // See isRangeNode() for definition of "range" vs "non-range" structures.
    if (isRangeNode(existing) && !isRangeNode(update)) {
      this.logger.debug(
        `[deepMerge] Range→non-range transition at path ${currentPath}, replacing instead of merging`
      );
      return update;
    }

    const merged: any = { ...existing };

    for (const [key, value] of Object.entries(update)) {
      const fieldPath = currentPath ? `${currentPath}.${key}` : key;

      // Check if value is a differential operations array
      const isDifferentialOps =
        Array.isArray(value) &&
        value.length > 0 &&
        Array.isArray(value[0]) &&
        typeof value[0][0] === "string";

      // Check if existing value is a range structure
      const existingIsRange =
        merged[key] &&
        typeof merged[key] === "object" &&
        !Array.isArray(merged[key]) &&
        Array.isArray(merged[key].d) &&
        Array.isArray(merged[key].s);

      if (isDifferentialOps && existingIsRange) {
        // Deep clone the range structure before modifying to avoid mutating the original
        // (shallow copy {...existing} keeps shared references to nested objects)
        merged[key] = deepClone(merged[key]);
        // Apply differential operations to the cloned range
        this.logger.debug(
          `[deepMerge] Applying diff ops at path ${fieldPath}`,
          { ops: value, rangeItems: merged[key].d?.length }
        );
        this.applyDifferentialOpsToRange(merged[key], value, fieldPath);
      } else if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        typeof merged[key] === "object" &&
        merged[key] !== null &&
        !Array.isArray(merged[key])
      ) {
        merged[key] = this.deepMergeTreeNodes(merged[key], value, fieldPath);
      } else {
        merged[key] = value;
      }
    }

    return merged;
  }

  /**
   * Applies differential operations to the provided range structure in-place.
   * The caller is responsible for passing the object to be mutated (typically a clone).
   * This is called when merging nested updates that contain range operations.
   */
  private applyDifferentialOpsToRange(
    rangeStructure: any,
    operations: any[],
    statePath: string
  ): void {
    // Validate rangeStructure before proceeding
    if (
      !rangeStructure ||
      typeof rangeStructure !== "object" ||
      !Array.isArray(rangeStructure.d) ||
      !Array.isArray(rangeStructure.s)
    ) {
      this.logger.error(
        `[applyDiffOpsToRange] Invalid rangeStructure at path ${statePath}`,
        { rangeStructure }
      );
      return;
    }

    const currentItems = rangeStructure.d;

    // Ensure rangeState is synchronized
    if (!this.rangeState[statePath]) {
      this.rangeState[statePath] = {
        items: currentItems,
        statics: rangeStructure.s,
        staticsMap: rangeStructure.sm,
      };
    }
    // Also check for idKey metadata
    if (
      rangeStructure.m &&
      typeof rangeStructure.m === "object" &&
      typeof rangeStructure.m.idKey === "string"
    ) {
      this.rangeIdKeys[statePath] = rangeStructure.m.idKey;
    }

    this.logger.debug(
      `[applyDiffOpsToRange] path=${statePath}, idKey=${this.rangeIdKeys[statePath]}, items=${currentItems.length}, ops=${operations.length}`
    );

    for (const operation of operations) {
      if (!Array.isArray(operation) || operation.length < 2) {
        continue;
      }

      const opType = operation[0];

      switch (opType) {
        case "r": {
          const key = operation[1];
          const removeIndex = this.findItemIndexByKey(
            currentItems,
            key,
            rangeStructure.s,
            statePath
          );
          this.logger.debug(
            `[applyDiffOpsToRange] Remove: key=${key}, index=${removeIndex}, total=${currentItems.length}`
          );
          if (removeIndex >= 0) {
            currentItems.splice(removeIndex, 1);
            this.logger.debug(`[applyDiffOpsToRange] After removal: ${currentItems.length} items`);
          } else {
            this.logger.debug(`[applyDiffOpsToRange] Remove failed: key ${key} not found`);
          }
          break;
        }
        case "u": {
          const updateIndex = this.findItemIndexByKey(
            currentItems,
            operation[1],
            rangeStructure.s,
            statePath
          );
          const changes = operation[2];
          if (updateIndex >= 0 && changes) {
            currentItems[updateIndex] = {
              ...currentItems[updateIndex],
              ...changes,
            };
          }
          break;
        }
        case "a": {
          const itemsToAdd = Array.isArray(operation[1])
            ? operation[1]
            : [operation[1]];
          if (operation[2]) {
            rangeStructure.s = operation[2];
          }
          currentItems.push(...itemsToAdd);
          if (
            operation[3] &&
            typeof operation[3] === "object" &&
            operation[3].idKey
          ) {
            this.rangeIdKeys[statePath] = operation[3].idKey;
          }
          break;
        }
        case "p": {
          const itemsToPrepend = Array.isArray(operation[1])
            ? operation[1]
            : [operation[1]];
          if (operation[2]) {
            rangeStructure.s = operation[2];
          }
          currentItems.unshift(...itemsToPrepend);
          break;
        }
        case "i": {
          const targetIndex = this.findItemIndexByKey(
            currentItems,
            operation[1],
            rangeStructure.s,
            statePath
          );
          if (targetIndex >= 0) {
            const itemsToInsert = Array.isArray(operation[2])
              ? operation[2]
              : [operation[2]];
            currentItems.splice(targetIndex + 1, 0, ...itemsToInsert);
          }
          break;
        }
        case "o": {
          const newOrder = operation[1] as string[];
          const reorderedItems: any[] = [];
          const itemsByKey = new Map<string, any>();

          for (const item of currentItems) {
            const itemKey = this.getItemKey(item, rangeStructure.s, statePath);
            if (itemKey) {
              itemsByKey.set(itemKey, item);
            }
          }

          for (const orderedKey of newOrder) {
            const item = itemsByKey.get(orderedKey);
            if (item) {
              reorderedItems.push(item);
            }
          }

          currentItems.length = 0;
          currentItems.push(...reorderedItems);
          break;
        }
        default:
          break;
      }
    }

    // Update rangeState to reflect the changes
    this.rangeState[statePath] = {
      items: currentItems,
      statics: rangeStructure.s,
      staticsMap: rangeStructure.sm,
    };
  }

  private reconstructFromTree(node: TreeNode, statePath: string): string {
    if (node.s && Array.isArray(node.s)) {
      let html = "";

      for (let i = 0; i < node.s.length; i++) {
        const staticSegment = node.s[i];
        html += staticSegment;

        if (i < node.s.length - 1) {
          const dynamicKey = i.toString();
          if (node[dynamicKey] !== undefined) {
            const newStatePath = statePath
              ? `${statePath}.${dynamicKey}`
              : dynamicKey;
            html += this.renderValue(
              node[dynamicKey],
              dynamicKey,
              newStatePath
            );
          }
        }
      }

      html = html.replace(/<root>/g, "").replace(/<\/root>/g, "");
      return html;
    }

    return this.renderValue(node, "", statePath);
  }

  private renderValue(
    value: any,
    fieldKey?: string,
    statePath?: string
  ): string {
    if (value === null || value === undefined) {
      return "";
    }

    if (
      typeof value === "string" &&
      value.startsWith("{{") &&
      value.endsWith("}}")
    ) {
      return "";
    }

    if (typeof value === "object" && !Array.isArray(value)) {
      if (
        value.d &&
        Array.isArray(value.d) &&
        value.s &&
        Array.isArray(value.s)
      ) {
        const stateKey = statePath || fieldKey || "";
        if (stateKey) {
          this.rangeState[stateKey] = {
            items: value.d,
            statics: value.s,
            staticsMap: value.sm,
          };
          if (
            value.m &&
            typeof value.m === "object" &&
            typeof value.m.idKey === "string"
          ) {
            this.rangeIdKeys[stateKey] = value.m.idKey;
          }
        }
        return this.renderRangeStructure(value, fieldKey, statePath);
      }

      if ("s" in value && Array.isArray((value as TreeNode).s)) {
        return this.reconstructFromTree(value as TreeNode, statePath || "");
      }

      // Handle objects with only numeric keys (dynamics without statics)
      // This occurs when server sends partial updates for nested TreeNodes
      const keys = Object.keys(value);
      const numericKeys = keys.filter((k) => /^\d+$/.test(k)).sort((a, b) => parseInt(a) - parseInt(b));
      if (numericKeys.length > 0 && numericKeys.length === keys.length) {
        // All keys are numeric - render each dynamic value in order
        return numericKeys
          .map((k) => {
            const itemStatePath = statePath ? `${statePath}.${k}` : k;
            return this.renderValue((value as Record<string, unknown>)[k], k, itemStatePath);
          })
          .join("");
      }
    }

    if (Array.isArray(value)) {
      if (
        value.length > 0 &&
        Array.isArray(value[0]) &&
        typeof value[0][0] === "string"
      ) {
        return this.applyDifferentialOperations(value, statePath);
      }

      return value
        .map((item, idx) => {
          const itemKey = idx.toString();
          const itemStatePath = statePath ? `${statePath}.${itemKey}` : itemKey;
          if (typeof item === "object" && item && (item as TreeNode).s) {
            return this.reconstructFromTree(item as TreeNode, itemStatePath);
          }
          return this.renderValue(item, itemKey, itemStatePath);
        })
        .join("");
    }

    if (typeof value === "object") {
      // Plain data objects (without tree structure) are state values that shouldn't be rendered.
      // This happens when state contains objects like EditingItem that are used by server-side
      // templates but aren't meant to be rendered directly in the DOM.
      // Skip them silently instead of converting to "[object Object]".
      this.logger.debug(
        "Skipping plain object value (not a tree node) - this is normal for state-only data"
      );
      return "";
    }

    return String(value);
  }

  private renderRangeStructure(
    rangeNode: any,
    fieldKey?: string,
    statePath?: string
  ): string {
    const { d: dynamics, s: statics, sm: staticsMap } = rangeNode;

    if (!dynamics || !Array.isArray(dynamics)) {
      return "";
    }

    if (dynamics.length === 0) {
      if (rangeNode["else"]) {
        const elseKey = "else";
        const elseStatePath = statePath ? `${statePath}.else` : "else";
        return this.renderValue(rangeNode["else"], elseKey, elseStatePath);
      }
      return "";
    }

    // Check if we have per-item statics via StaticsMap
    const hasStaticsMap = staticsMap && typeof staticsMap === "object";

    if (statics && Array.isArray(statics)) {
      return dynamics
        .map((item: any, itemIdx: number) => {
          // Get per-item statics from StaticsMap if available, otherwise use shared statics
          let itemStatics = statics;
          if (hasStaticsMap && item._sk && staticsMap[item._sk]) {
            itemStatics = staticsMap[item._sk];
          }

          let html = "";

          for (let i = 0; i < itemStatics.length; i++) {
            html += itemStatics[i];

            if (i < itemStatics.length - 1) {
              const localKey = i.toString();
              if (item[localKey] !== undefined) {
                const itemStatePath = statePath
                  ? `${statePath}.${itemIdx}.${localKey}`
                  : `${itemIdx}.${localKey}`;
                html += this.renderValue(
                  item[localKey],
                  localKey,
                  itemStatePath
                );
              }
            }
          }

          return html;
        })
        .join("");
    }

    return dynamics
      .map((item: any, idx: number) => {
        const itemKey = idx.toString();
        const itemStatePath = statePath ? `${statePath}.${itemKey}` : itemKey;
        return this.renderValue(item, itemKey, itemStatePath);
      })
      .join("");
  }

  private applyDifferentialOperations(
    operations: any[],
    statePath?: string
  ): string {
    if (!statePath || !this.rangeState[statePath]) {
      return "";
    }

    const rangeData = this.rangeState[statePath];
    const currentItems = [...rangeData.items];
    const statics = rangeData.statics;

    for (const operation of operations) {
      if (!Array.isArray(operation) || operation.length < 2) {
        continue;
      }

      const opType = operation[0];

      switch (opType) {
        case "r": {
          const removeIndex = this.findItemIndexByKey(
            currentItems,
            operation[1],
            statics,
            statePath
          );
          if (removeIndex >= 0) {
            currentItems.splice(removeIndex, 1);
          }
          break;
        }
        case "u": {
          const updateIndex = this.findItemIndexByKey(
            currentItems,
            operation[1],
            statics,
            statePath
          );
          const changes = operation[2];
          if (updateIndex >= 0 && changes) {
            currentItems[updateIndex] = {
              ...currentItems[updateIndex],
              ...changes,
            };
          }
          break;
        }
        case "a": {
          this.addItemsToRange(
            currentItems,
            operation[1],
            operation[2],
            rangeData,
            false
          );
          if (
            operation[3] &&
            typeof operation[3] === "object" &&
            operation[3].idKey
          ) {
            this.rangeIdKeys[statePath || ""] = operation[3].idKey;
          }
          break;
        }
        case "p": {
          this.addItemsToRange(
            currentItems,
            operation[1],
            operation[2],
            rangeData,
            true
          );
          break;
        }
        case "i": {
          const targetIndex = this.findItemIndexByKey(
            currentItems,
            operation[1],
            statics,
            statePath
          );
          if (targetIndex >= 0) {
            const itemsToInsert = Array.isArray(operation[2])
              ? operation[2]
              : [operation[2]];
            currentItems.splice(targetIndex + 1, 0, ...itemsToInsert);
          }
          break;
        }
        case "o": {
          const newOrder = operation[1] as string[];
          const reorderedItems: any[] = [];
          const itemsByKey = new Map<string, any>();

          for (const item of currentItems) {
            const itemKey = this.getItemKey(item, statics, statePath);
            if (itemKey) {
              itemsByKey.set(itemKey, item);
            }
          }

          for (const orderedKey of newOrder) {
            const item = itemsByKey.get(orderedKey);
            if (item) {
              reorderedItems.push(item);
            }
          }

          currentItems.length = 0;
          currentItems.push(...reorderedItems);
          break;
        }
        default:
          break;
      }
    }

    this.rangeState[statePath] = {
      items: currentItems,
      statics: rangeData.statics,
      staticsMap: rangeData.staticsMap,
    };

    this.treeState[statePath] = {
      d: currentItems,
      s: rangeData.statics,
      sm: rangeData.staticsMap,
    };

    const rangeStructure = this.getCurrentRangeStructure(statePath);
    if (rangeStructure && rangeStructure.s) {
      return this.renderItemsWithStatics(
        currentItems,
        rangeStructure.s,
        rangeStructure.sm,
        statePath
      );
    }

    return currentItems.map((item) => this.renderValue(item)).join("");
  }

  private getCurrentRangeStructure(stateKey: string): any {
    if (this.rangeState[stateKey]) {
      return {
        d: this.rangeState[stateKey].items,
        s: this.rangeState[stateKey].statics,
        sm: this.rangeState[stateKey].staticsMap,
      };
    }

    const fieldValue = this.treeState[stateKey];
    if (
      fieldValue &&
      typeof fieldValue === "object" &&
      (fieldValue as TreeNode).s
    ) {
      return fieldValue;
    }

    return null;
  }

  private renderItemsWithStatics(
    items: any[],
    statics: string[],
    staticsMap?: Record<string, string[]>,
    statePath?: string
  ): string {
    const result = items
      .map((item: any, itemIdx: number) => {
        // Get per-item statics from StaticsMap if available, otherwise use shared statics
        let itemStatics = statics;
        if (
          staticsMap &&
          typeof staticsMap === "object" &&
          item._sk &&
          staticsMap[item._sk]
        ) {
          itemStatics = staticsMap[item._sk];
        }

        let html = "";

        for (let i = 0; i < itemStatics.length; i++) {
          html += itemStatics[i];

          if (i < itemStatics.length - 1) {
            const fieldKey = i.toString();
            if (item[fieldKey] !== undefined) {
              const itemStatePath = statePath
                ? `${statePath}.${itemIdx}.${fieldKey}`
                : `${itemIdx}.${fieldKey}`;
              html += this.renderValue(item[fieldKey], fieldKey, itemStatePath);
            }
          }
        }

        return html;
      })
      .join("");

    if (this.logger.isDebugEnabled()) {
      this.logger.debug("[renderItemsWithStatics] statics:", statics);
      this.logger.debug("[renderItemsWithStatics] items count:", items.length);
      this.logger.debug(
        "[renderItemsWithStatics] result snippet:",
        result.substring(0, 200)
      );
    }

    return result;
  }

  private addItemsToRange(
    currentItems: any[],
    items: any,
    statics: any[] | undefined,
    rangeData: RangeStateEntry,
    prepend: boolean
  ): void {
    if (statics) {
      rangeData.statics = statics;
    }

    if (!items) return;

    const itemsArray = Array.isArray(items) ? items : [items];
    if (prepend) {
      currentItems.unshift(...itemsArray);
    } else {
      currentItems.push(...itemsArray);
    }
  }

  private getItemKey(
    item: any,
    statics: any[],
    statePath?: string
  ): string | null {
    if (!statePath || !this.rangeIdKeys[statePath]) {
      return null;
    }

    const keyPosStr = this.rangeIdKeys[statePath];
    return item[keyPosStr] || null;
  }

  private findItemIndexByKey(
    items: any[],
    key: string,
    statics: any[],
    statePath?: string
  ): number {
    return items.findIndex(
      (item: any) => this.getItemKey(item, statics, statePath) === key
    );
  }
}
