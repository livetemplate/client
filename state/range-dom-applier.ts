import morphdom from "morphdom";
import type { Logger } from "../utils/logger";
import type { TargetedRangeOp } from "../types";

const KEY_ATTRIBUTES = ["data-key", "data-lvt-key"] as const;
export const TARGETED_APPLIED_ATTR = "data-lvt-targeted-applied";
export const TARGETED_SKIP_ATTR = "data-lvt-targeted-skip";

type RenderItemFn = (
  item: any,
  itemIdx: number,
  statics: string[],
  staticsMap?: Record<string, string[]>,
  statePath?: string
) => string;

type LifecycleHookFn = (el: Element, hookName: string) => void;

export interface RangeDomApplierContext {
  logger: Logger;
  renderItem: RenderItemFn;
  executeLifecycleHook: LifecycleHookFn;
}

export interface CanApplyResult {
  ok: boolean;
  reason?: string;
  container?: Element;
  containerKey?: string;
}

/**
 * Applies range diff ops directly to the live DOM, bypassing full HTML
 * reconstruction + morphdom diff. Designed to handle the common case where
 * a 10k-row range receives a single-row mutation; the targeted path turns
 * what would be a 5+ second morphdom walk into a sub-millisecond DOM op.
 *
 * The applier is opt-in per range: `canApplyTargeted` checks that the
 * range has data-key emission, no nested-range items, and a resolvable
 * container element. When any check fails, the caller falls back to the
 * existing applyUpdate → reconstructFromTree → morphdom path.
 */
export class RangeDomApplier {
  private containerCache = new Map<string, Element>();

  constructor(private readonly ctx: RangeDomApplierContext) {}

  invalidate(): void {
    this.containerCache.clear();
  }

  invalidatePath(rangePath: string): void {
    this.containerCache.delete(rangePath);
  }

  /**
   * Locate the live container element for a range path. The container is
   * the parent element of items rendered with data-key. Cached per path;
   * cache invalidated automatically when a cached element becomes detached.
   */
  findContainer(
    wrapper: Element,
    rangePath: string,
    anyKnownItemKey?: string
  ): Element | null {
    const cached = this.containerCache.get(rangePath);
    if (cached && cached.isConnected && wrapper.contains(cached)) {
      return cached;
    }
    if (cached) {
      this.containerCache.delete(rangePath);
    }

    let sample: Element | null = null;
    if (anyKnownItemKey !== undefined) {
      sample = this.findItemByKey(wrapper, anyKnownItemKey);
    }
    if (!sample) {
      for (const attr of KEY_ATTRIBUTES) {
        sample = wrapper.querySelector(`[${attr}]`);
        if (sample) break;
      }
    }
    if (!sample || !sample.parentElement) {
      return null;
    }

    const container = sample.parentElement;
    this.containerCache.set(rangePath, container);
    return container;
  }

  /**
   * Decide whether a range update can take the targeted-apply path.
   * Returns the resolved container in the success case so the caller
   * can pass it to `apply` without re-resolving.
   */
  canApplyTargeted(
    wrapper: Element,
    rangeStructure: any,
    rangePath: string
  ): CanApplyResult {
    if (!rangeStructure || typeof rangeStructure !== "object") {
      return { ok: false, reason: "no range structure" };
    }
    if (!Array.isArray(rangeStructure.s) || rangeStructure.s.length === 0) {
      return { ok: false, reason: "no statics" };
    }

    const allStatics: string[][] = [rangeStructure.s];
    if (rangeStructure.sm && typeof rangeStructure.sm === "object") {
      for (const sm of Object.values(rangeStructure.sm)) {
        if (Array.isArray(sm)) {
          allStatics.push(sm as string[]);
        }
      }
    }

    const hasKeyInStatics = allStatics.some((arr) =>
      this.staticsContainKeyAttribute(arr)
    );
    if (!hasKeyInStatics) {
      return { ok: false, reason: "no data-key attribute in statics" };
    }

    const items = rangeStructure.d;
    if (Array.isArray(items)) {
      for (const item of items) {
        if (this.itemHasNestedRange(item)) {
          return { ok: false, reason: "nested-range item" };
        }
      }
    }

    const sampleKey = this.extractItemKey(items?.[0], rangeStructure);
    const container = this.findContainer(wrapper, rangePath, sampleKey);
    if (!container) {
      return { ok: false, reason: "container not found in DOM" };
    }

    let cur: Element | null = container;
    while (cur && cur !== wrapper) {
      if (cur.hasAttribute("lvt-ignore")) {
        return { ok: false, reason: "lvt-ignore ancestor" };
      }
      cur = cur.parentElement;
    }

    return { ok: true, container, containerKey: sampleKey };
  }

  /**
   * Apply a single targeted op to the live DOM. Returns the affected
   * container element so the caller can mark it for the morphdom skip
   * mechanism. Returns null if the op could not be applied (caller
   * should fall back to full-rebuild for the next render).
   */
  apply(
    wrapper: Element,
    targetedOp: TargetedRangeOp,
    morphdomOptions?: any
  ): Element | null {
    const { rangePath, ops, statics, staticsMap } = targetedOp;
    const sampleKey = this.firstKnownKey(ops);
    const container = this.findContainer(wrapper, rangePath, sampleKey);
    if (!container) {
      this.ctx.logger.debug(
        `[RangeDomApplier] container not found for range ${rangePath}; cannot apply`
      );
      return null;
    }

    for (const op of ops) {
      if (!Array.isArray(op) || op.length < 1) continue;
      const opType = op[0];
      try {
        switch (opType) {
          case "r":
            this.applyRemove(container, op[1] as string);
            break;
          case "u":
            this.applyUpdateRow(
              container,
              op[1] as string,
              statics,
              staticsMap,
              rangePath,
              morphdomOptions
            );
            break;
          case "i":
            this.applyInsertAfter(
              container,
              op[1] as string,
              op[2],
              statics,
              staticsMap,
              rangePath
            );
            break;
          case "a":
            this.applyAppend(container, op[1], statics, staticsMap, rangePath);
            break;
          case "p":
            this.applyPrepend(container, op[1], statics, staticsMap, rangePath);
            break;
          case "o":
            this.applyReorder(container, op[1] as string[]);
            break;
          default:
            this.ctx.logger.debug(
              `[RangeDomApplier] unknown op type ${opType}; ignoring`
            );
        }
      } catch (err) {
        this.ctx.logger.error(
          `[RangeDomApplier] op ${opType} failed for range ${rangePath}`,
          err
        );
        return null;
      }
    }

    return container;
  }

  cleanupMarkers(wrapper: Element): void {
    const applied = wrapper.querySelectorAll(`[${TARGETED_APPLIED_ATTR}]`);
    applied.forEach((el) => el.removeAttribute(TARGETED_APPLIED_ATTR));
    if (wrapper.hasAttribute(TARGETED_APPLIED_ATTR)) {
      wrapper.removeAttribute(TARGETED_APPLIED_ATTR);
    }
    const skip = wrapper.querySelectorAll(`[${TARGETED_SKIP_ATTR}]`);
    skip.forEach((el) => el.removeAttribute(TARGETED_SKIP_ATTR));
    if (wrapper.hasAttribute(TARGETED_SKIP_ATTR)) {
      wrapper.removeAttribute(TARGETED_SKIP_ATTR);
    }
  }

  // --- per-op implementations -----------------------------------------------

  private applyRemove(container: Element, key: string): void {
    const row = this.findItemByKey(container, key);
    if (!row) {
      this.ctx.logger.debug(
        `[RangeDomApplier] r: row with key ${key} not found`
      );
      return;
    }
    this.fireHookOnSubtree(row, "lvt-destroyed");
    row.remove();
  }

  private applyUpdateRow(
    container: Element,
    key: string,
    statics: string[],
    staticsMap: Record<string, string[]> | undefined,
    rangePath: string,
    morphdomOptions?: any
  ): void {
    const row = this.findItemByKey(container, key);
    if (!row) {
      this.ctx.logger.debug(
        `[RangeDomApplier] u: row with key ${key} not found`
      );
      return;
    }
    const itemIdx = this.indexOfChild(container, row);
    const item = this.lookupCurrentItem(rangePath, key);
    if (!item) {
      this.ctx.logger.debug(
        `[RangeDomApplier] u: item state for key ${key} not available; skipping`
      );
      return;
    }
    const newHtml = this.ctx.renderItem(
      item,
      itemIdx,
      statics,
      staticsMap,
      rangePath
    );
    const newRow = this.parseSingleRow(newHtml);
    if (!newRow) {
      this.ctx.logger.warn(
        `[RangeDomApplier] u: failed to parse rendered row HTML`
      );
      return;
    }
    if (morphdomOptions) {
      morphdom(row, newRow, morphdomOptions);
    } else {
      row.replaceWith(newRow);
    }
  }

  private applyInsertAfter(
    container: Element,
    afterKey: string,
    items: any | any[],
    statics: string[],
    staticsMap: Record<string, string[]> | undefined,
    rangePath: string
  ): void {
    const anchor = this.findItemByKey(container, afterKey);
    if (!anchor) {
      this.ctx.logger.debug(
        `[RangeDomApplier] i: anchor key ${afterKey} not found`
      );
      return;
    }
    const list = Array.isArray(items) ? items : [items];
    const baseIdx = this.indexOfChild(container, anchor) + 1;
    let cursor: Node | null = anchor.nextSibling;
    list.forEach((item, offset) => {
      const newRow = this.renderAndParse(
        item,
        baseIdx + offset,
        statics,
        staticsMap,
        rangePath
      );
      if (!newRow) return;
      container.insertBefore(newRow, cursor);
      this.fireHookOnSubtree(newRow, "lvt-mounted");
      cursor = newRow.nextSibling;
    });
  }

  private applyAppend(
    container: Element,
    items: any | any[],
    statics: string[],
    staticsMap: Record<string, string[]> | undefined,
    rangePath: string
  ): void {
    const list = Array.isArray(items) ? items : [items];
    const baseIdx = container.children.length;
    list.forEach((item, offset) => {
      const newRow = this.renderAndParse(
        item,
        baseIdx + offset,
        statics,
        staticsMap,
        rangePath
      );
      if (!newRow) return;
      container.appendChild(newRow);
      this.fireHookOnSubtree(newRow, "lvt-mounted");
    });
  }

  private applyPrepend(
    container: Element,
    items: any | any[],
    statics: string[],
    staticsMap: Record<string, string[]> | undefined,
    rangePath: string
  ): void {
    const list = Array.isArray(items) ? items : [items];
    const fragment = document.createDocumentFragment();
    const mounted: Element[] = [];
    list.forEach((item, offset) => {
      const newRow = this.renderAndParse(
        item,
        offset,
        statics,
        staticsMap,
        rangePath
      );
      if (!newRow) return;
      fragment.appendChild(newRow);
      mounted.push(newRow);
    });
    container.insertBefore(fragment, container.firstChild);
    mounted.forEach((row) => this.fireHookOnSubtree(row, "lvt-mounted"));
  }

  private applyReorder(container: Element, newKeyOrder: string[]): void {
    if (!Array.isArray(newKeyOrder)) return;
    const byKey = new Map<string, Element>();
    Array.from(container.children).forEach((child) => {
      for (const attr of KEY_ATTRIBUTES) {
        const k = child.getAttribute(attr);
        if (k !== null) {
          byKey.set(k, child);
          break;
        }
      }
    });

    const fragment = document.createDocumentFragment();
    for (const key of newKeyOrder) {
      const el = byKey.get(key);
      if (el) {
        fragment.appendChild(el);
      }
    }

    container.replaceChildren(fragment);
  }

  // --- helpers --------------------------------------------------------------

  private renderAndParse(
    item: any,
    itemIdx: number,
    statics: string[],
    staticsMap: Record<string, string[]> | undefined,
    rangePath: string
  ): Element | null {
    const html = this.ctx.renderItem(
      item,
      itemIdx,
      statics,
      staticsMap,
      rangePath
    );
    return this.parseSingleRow(html);
  }

  /**
   * Parse a string of HTML containing a single root element and return it.
   * Uses <template> so orphan table-cell content (`<tr>`, `<td>`, etc.)
   * is tolerated by the parser.
   */
  private parseSingleRow(html: string): Element | null {
    const template = document.createElement("template");
    template.innerHTML = html.trim();
    const first = template.content.firstElementChild;
    return first ?? null;
  }

  private findItemByKey(scope: Element, key: string): Element | null {
    const escaped =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(key)
        : key.replace(/(["\\])/g, "\\$1");
    for (const attr of KEY_ATTRIBUTES) {
      const el = scope.querySelector(`[${attr}="${escaped}"]`);
      if (el) return el;
    }
    return null;
  }

  private indexOfChild(container: Element, child: Element): number {
    let i = 0;
    let cur = container.firstElementChild;
    while (cur) {
      if (cur === child) return i;
      i++;
      cur = cur.nextElementSibling;
    }
    return -1;
  }

  private firstKnownKey(ops: any[]): string | undefined {
    for (const op of ops) {
      if (!Array.isArray(op) || op.length < 2) continue;
      const t = op[0];
      if (t === "r" || t === "u" || t === "i") {
        return typeof op[1] === "string" ? op[1] : undefined;
      }
      if (t === "o" && Array.isArray(op[1]) && op[1].length > 0) {
        return typeof op[1][0] === "string" ? op[1][0] : undefined;
      }
    }
    return undefined;
  }

  private staticsContainKeyAttribute(statics: string[]): boolean {
    for (const s of statics) {
      if (typeof s !== "string") continue;
      for (const attr of KEY_ATTRIBUTES) {
        if (s.includes(attr + "=") || s.includes(attr + " ")) {
          return true;
        }
      }
    }
    return false;
  }

  private itemHasNestedRange(item: any): boolean {
    if (!item || typeof item !== "object") return false;
    for (const [key, val] of Object.entries(item)) {
      if (key.startsWith("_")) continue;
      if (val && typeof val === "object" && !Array.isArray(val)) {
        const v = val as any;
        if (Array.isArray(v.d) && Array.isArray(v.s)) return true;
        if (this.itemHasNestedRange(v)) return true;
      }
    }
    return false;
  }

  private extractItemKey(item: any, rangeStructure: any): string | undefined {
    if (!item || typeof item !== "object") return undefined;
    if (item._k !== undefined) return String(item._k);
    const idKey = rangeStructure?.m?.idKey;
    if (idKey && item[idKey] !== undefined) return String(item[idKey]);
    return undefined;
  }

  /**
   * Override hook used by `applyUpdateRow` to read the current item state
   * after the diff op has been applied to treeState. Wired by the caller
   * via context (see `wireItemLookup`).
   */
  private itemLookup: ((rangePath: string, key: string) => any) | null = null;

  wireItemLookup(fn: (rangePath: string, key: string) => any): void {
    this.itemLookup = fn;
  }

  private lookupCurrentItem(rangePath: string, key: string): any {
    return this.itemLookup ? this.itemLookup(rangePath, key) : null;
  }

  private fireHookOnSubtree(root: Element, hookName: string): void {
    if (root.hasAttribute(hookName)) {
      this.ctx.executeLifecycleHook(root, hookName);
    }
    const descendants = root.querySelectorAll(`[${hookName}]`);
    descendants.forEach((el) =>
      this.ctx.executeLifecycleHook(el, hookName)
    );
  }
}
