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
type NodeAddedFn = (el: Element) => void;
type ItemLookupFn = (rangePath: string, key: string) => any;

export interface RangeDomApplierContext {
  logger: Logger;
  renderItem: RenderItemFn;
  executeLifecycleHook: LifecycleHookFn;
  /**
   * Look up the current item state for the given range path + key. Used by
   * the `u` op to render the FULL post-merge item (treeState is mutated in
   * place by `applyDifferentialOpsToRange` before the applier runs).
   *
   * Required: an applier without an `itemLookup` would silently no-op every
   * `u` op, leaving the live DOM stale while morphdom's skip marker
   * prevents the fallback diff from running. The constructor enforces this.
   */
  itemLookup: ItemLookupFn;
  /**
   * Notification that the applier inserted a new element into the live DOM
   * (i/a/p ops). Lets the caller track per-render DOM additions so it can
   * decide whether the post-render directive scans need to walk the wrapper.
   */
  onNodeAdded?: NodeAddedFn;
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
   *
   * Resolution order:
   *   1. Cached container (if still connected to the wrapper).
   *   2. `wrapper.querySelector('[data-key="anyKnownItemKey"]').parentElement`.
   *
   * The original implementation also fell back to an unscoped
   * `wrapper.querySelector('[data-key]')` walk, but that could return a
   * container belonging to a *different* keyed range when the wrapper has
   * more than one — silently mutating the wrong DOM subtree on subsequent
   * ops. We now prefer to fail closed (return null → caller falls back to
   * full rebuild) over mutating an unrelated container.
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

    if (anyKnownItemKey === undefined) {
      return null;
    }
    const sample = this.findItemByKey(wrapper, anyKnownItemKey);
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

    // Walk up from container through wrapper (inclusive) — if any element
    // on the path is lvt-ignore'd, the targeted-apply path would mutate
    // DOM inside an ignored subtree while morphdom would have skipped it,
    // violating the lvt-ignore contract.
    let cur: Element | null = container;
    while (cur) {
      if (cur.hasAttribute("lvt-ignore")) {
        return { ok: false, reason: "lvt-ignore ancestor" };
      }
      if (cur === wrapper) break;
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

    let allOpsSucceeded = true;
    for (const op of ops) {
      if (!Array.isArray(op) || op.length < 1) continue;
      const opType = op[0];
      try {
        let opOK = true;
        switch (opType) {
          case "r":
            opOK = this.applyRemove(container, op[1] as string);
            break;
          case "u":
            opOK = this.applyUpdateRow(
              container,
              op[1] as string,
              statics,
              staticsMap,
              rangePath,
              morphdomOptions
            );
            break;
          case "i":
            opOK = this.applyInsertAfter(
              container,
              op[1] as string,
              op[2],
              statics,
              staticsMap,
              rangePath
            );
            break;
          case "a":
            opOK = this.applyAppend(
              container,
              op[1],
              statics,
              staticsMap,
              rangePath
            );
            break;
          case "p":
            opOK = this.applyPrepend(
              container,
              op[1],
              statics,
              staticsMap,
              rangePath
            );
            break;
          case "o":
            opOK = this.applyReorder(container, op[1] as string[]);
            break;
          default:
            // Forward-compat: an unrecognised op type means we can't
            // reason about the DOM mutation. Treat as failure so the
            // caller falls back to a full morphdom rebuild from
            // treeState (which the server-emitted unknown op type
            // presumably already mutated correctly).
            this.ctx.logger.warn(
              `[RangeDomApplier] unknown op type ${opType}; falling back`
            );
            opOK = false;
        }
        if (!opOK) {
          allOpsSucceeded = false;
        }
      } catch (err) {
        this.ctx.logger.error(
          `[RangeDomApplier] op ${opType} failed for range ${rangePath}`,
          err
        );
        return null;
      }
    }

    // If any per-op method silently no-op'd because of stale state
    // (e.g. `u` for a row that's no longer in the DOM, `i` with a
    // missing anchor), we MUST signal failure so the caller falls back
    // to a full rebuild — otherwise the live DOM stays out of sync with
    // treeState and morphdom would skip the subtree (TARGETED_APPLIED
    // marker tells it to).
    if (!allOpsSucceeded) {
      return null;
    }

    // Observability hook: increment a global counter so E2E tests can
    // assert the targeted-apply path was actually taken (vs silently
    // hitting the fallback). Opt-in: tests must initialize the property
    // first (e.g. `window.__lvtTargetedHits = 0`); production never sets
    // it so the increment is skipped and we don't pollute the window
    // object outside of test environments.
    if (
      typeof window !== "undefined" &&
      "__lvtTargetedHits" in (window as any)
    ) {
      (window as any).__lvtTargetedHits++;
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
  //
  // Each per-op method returns `boolean`:
  //   true  → the live DOM is now consistent with the new treeState
  //   false → silent no-op (e.g. row not found, item state unavailable);
  //           the caller should invalidate the targeted-apply marker and
  //           fall back to a full rebuild

  private applyRemove(container: Element, key: string): boolean {
    const row = this.findItemByKey(container, key);
    if (!row) {
      // r is idempotent: if the row is already gone, treeState's post-op
      // view (also without the row) matches the DOM. No fallback needed.
      this.ctx.logger.debug(
        `[RangeDomApplier] r: row with key ${key} not found (idempotent no-op)`
      );
      return true;
    }
    this.fireHookOnSubtree(row, "lvt-destroyed");
    row.remove();
    return true;
  }

  private applyUpdateRow(
    container: Element,
    key: string,
    statics: string[],
    staticsMap: Record<string, string[]> | undefined,
    rangePath: string,
    morphdomOptions?: any
  ): boolean {
    const row = this.findItemByKey(container, key);
    if (!row) {
      this.ctx.logger.debug(
        `[RangeDomApplier] u: row with key ${key} not found in DOM; falling back`
      );
      return false;
    }
    const itemIdx = this.indexOfChild(container, row);
    const item = this.lookupCurrentItem(rangePath, key);
    if (!item) {
      this.ctx.logger.debug(
        `[RangeDomApplier] u: item state for key ${key} not available; falling back`
      );
      return false;
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
        `[RangeDomApplier] u: failed to parse rendered row HTML; falling back`
      );
      return false;
    }
    if (morphdomOptions) {
      // Override childrenOnly: the main morphdom call uses childrenOnly:true
      // because it's diffing the wrapper's children. For a single-row morph
      // we MUST diff the row element itself too (its attributes — class,
      // style, aria, etc. — are produced by statics+dynamics and may have
      // changed). Reuse the same callbacks for behavioral consistency.
      morphdom(row, newRow, { ...morphdomOptions, childrenOnly: false });
    } else {
      // No morphdom options provided — fall back to wholesale replacement.
      // morphdom's onNodeAdded / onBeforeNodeDiscarded callbacks would
      // normally fire lvt-mounted/lvt-destroyed hooks for us; here we have
      // to fire them manually on both sides AND notify the host so its
      // nodesAddedThisRender counter sees the new subtree (otherwise the
      // post-render directive scans would skip wiring listeners on it).
      this.fireHookOnSubtree(row, "lvt-destroyed");
      row.replaceWith(newRow);
      this.ctx.onNodeAdded?.(newRow);
      this.fireHookOnSubtree(newRow, "lvt-mounted");
    }
    return true;
  }

  private applyInsertAfter(
    container: Element,
    afterKey: string,
    items: any | any[],
    statics: string[],
    staticsMap: Record<string, string[]> | undefined,
    rangePath: string
  ): boolean {
    const anchor = this.findItemByKey(container, afterKey);
    if (!anchor) {
      this.ctx.logger.debug(
        `[RangeDomApplier] i: anchor key ${afterKey} not found; falling back`
      );
      return false;
    }
    return this.renderItemsAtomic(
      container,
      items,
      statics,
      staticsMap,
      rangePath,
      this.indexOfChild(container, anchor) + 1,
      (frag) => container.insertBefore(frag, anchor.nextSibling)
    );
  }

  private applyAppend(
    container: Element,
    items: any | any[],
    statics: string[],
    staticsMap: Record<string, string[]> | undefined,
    rangePath: string
  ): boolean {
    return this.renderItemsAtomic(
      container,
      items,
      statics,
      staticsMap,
      rangePath,
      container.children.length,
      (frag) => container.appendChild(frag)
    );
  }

  private applyPrepend(
    container: Element,
    items: any | any[],
    statics: string[],
    staticsMap: Record<string, string[]> | undefined,
    rangePath: string
  ): boolean {
    return this.renderItemsAtomic(
      container,
      items,
      statics,
      staticsMap,
      rangePath,
      0,
      (frag) => container.insertBefore(frag, container.firstChild)
    );
  }

  /**
   * Render N items into a scratch DocumentFragment, splicing them into the
   * live DOM only if ALL renders succeeded. On partial failure no DOM
   * mutation happens and the caller falls back to a full rebuild — this
   * avoids `lvt-mounted` firing on items that morphdom is then about to
   * re-add (which would double-fire the hook).
   */
  private renderItemsAtomic(
    container: Element,
    items: any | any[],
    statics: string[],
    staticsMap: Record<string, string[]> | undefined,
    rangePath: string,
    baseIdx: number,
    splice: (frag: DocumentFragment) => void
  ): boolean {
    void container;
    const list = Array.isArray(items) ? items : [items];
    const scratch = document.createDocumentFragment();
    const newRows: Element[] = [];
    for (let i = 0; i < list.length; i++) {
      const newRow = this.renderAndParse(
        list[i],
        baseIdx + i,
        statics,
        staticsMap,
        rangePath
      );
      if (!newRow) {
        return false;
      }
      scratch.appendChild(newRow);
      newRows.push(newRow);
    }
    splice(scratch);
    for (const row of newRows) {
      this.ctx.onNodeAdded?.(row);
      this.fireHookOnSubtree(row, "lvt-mounted");
    }
    return true;
  }

  /**
   * Reorder existing children to match `newKeyOrder`. Protocol assumption:
   * the server emits the *full* new key order (mirrors the assumption in
   * `applyDifferentialOpsToRange`'s "o" case in tree-renderer). Children
   * whose keys aren't in `newKeyOrder` are dropped without firing
   * lvt-destroyed — if the server ever starts sending partial reorder ops,
   * this would silently delete rows. We log a warning when that happens
   * so the protocol mismatch is visible.
   */
  private applyReorder(container: Element, newKeyOrder: string[]): boolean {
    if (!Array.isArray(newKeyOrder)) return false;
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
    const newKeySet = new Set(newKeyOrder);
    for (const key of newKeyOrder) {
      const el = byKey.get(key);
      if (el) {
        fragment.appendChild(el);
      }
    }

    // Fire lvt-destroyed on children that aren't in the new order. The
    // protocol normally sends the FULL key order, but if a partial reorder
    // ever lands here, user-defined teardown (timer cancellation, observer
    // disconnect, etc.) must still run.
    if (newKeySet.size < byKey.size) {
      this.ctx.logger.warn(
        `[RangeDomApplier] o: newKeyOrder (${newKeySet.size}) shorter than existing children (${byKey.size}); ${byKey.size - newKeySet.size} children will be dropped`
      );
      for (const [k, el] of byKey) {
        if (!newKeySet.has(k)) {
          this.fireHookOnSubtree(el, "lvt-destroyed");
        }
      }
    }

    container.replaceChildren(fragment);
    return true;
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
    let escaped: string;
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      escaped = CSS.escape(key);
    } else {
      // CSS.escape polyfill is incomplete: only handles `"` and `\`.
      // Keys containing other CSS special chars ([], (), :, ., #, >, ~,
      // whitespace, etc.) would produce a malformed selector and miss the
      // match. Warn so it's visible in test logs rather than silently
      // returning null and looking like the row simply doesn't exist.
      if (/[\[\]():.#>~+*=^$|! \t\n\r]/.test(key)) {
        this.ctx.logger.warn(
          `[RangeDomApplier] CSS.escape unavailable; key "${key}" contains characters that need escaping. Lookup may miss the row.`
        );
      }
      escaped = key.replace(/(["\\])/g, "\\$1");
    }
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
    // Reduces false positives vs. plain `s.includes('data-key=')`:
    //   - requires word boundary before the attr name (excludes longer
    //     attribute names like `data-keystone=`, `my-data-key=`)
    //   - requires `=` to follow optional whitespace (excludes
    //     `data-key-something`)
    //
    // Known limitation: cannot distinguish a real attribute from
    // `data-key=` appearing inside a quoted attribute value (e.g.
    // `title='see data-key=foo'`). Such cases would still match. False
    // positives are safe — `findContainer` just fails to locate by key,
    // canApplyTargeted falls back to full rebuild — but they cost a
    // render of wasted work. Real-world templates with `data-key` in
    // attribute values are vanishingly rare.
    for (const s of statics) {
      if (typeof s !== "string") continue;
      for (const attr of KEY_ATTRIBUTES) {
        const re = new RegExp(`(?:^|[\\s<])${attr}\\s*=`);
        if (re.test(s)) {
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

  private lookupCurrentItem(rangePath: string, key: string): any {
    // O(N) over range.d via the context callback (linear scan in
    // livetemplate-client.ts). Bounded cost per `u` op: one walk per
    // updated row per render. At N=10k that's ~50µs in JS — acceptable.
    return this.ctx.itemLookup(rangePath, key);
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
