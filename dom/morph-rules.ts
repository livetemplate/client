/**
 * Rules the whole-page morph and the sibling pre-pass (dom/sibling-pairing.ts)
 * must agree on: an element's own key, and which subtrees morphdom leaves alone.
 */

import { KEY_ATTRIBUTES, TARGETED_SKIP_ATTR } from "../state/range-dom-applier";

/**
 * authorKey is an element's own reconciliation key: data-key, then
 * data-lvt-key. An empty value is no key.
 */
export function authorKey(el: Element): string | undefined {
  for (const attr of KEY_ATTRIBUTES) {
    const v = el.getAttribute(attr);
    if (v) return v;
  }
  return undefined;
}

/**
 * targetedSkip: the range applier already updated this container in place, so
 * morphdom leaves its subtree alone.
 */
export function targetedSkip(toEl: Element): boolean {
  return toEl.hasAttribute(TARGETED_SKIP_ATTR);
}

/**
 * ignored: lvt-ignore on the live element keeps its subtree as it is, unless
 * the server's version carries data-lvt-force-update.
 */
export function ignored(fromEl: Element, toEl: Element): boolean {
  return fromEl.hasAttribute("lvt-ignore") && !toEl.hasAttribute("data-lvt-force-update");
}

/** morphSkips: morphdom won't descend into this pair. */
export function morphSkips(fromEl: Element, toEl: Element): boolean {
  return targetedSkip(toEl) || ignored(fromEl, toEl);
}
