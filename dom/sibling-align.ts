/**
 * Line up one container's children with the incoming render before morphdom
 * walks them, so an element appearing or going away doesn't rebuild the
 * siblings after it.
 *
 * morphdom pairs unkeyed siblings by position, matching on tag name alone. So
 * when a conditional puts an element in front of unkeyed siblings, it morphs
 * each sibling into the one before it and builds a fresh copy of the last,
 * moving keyed descendants into that copy (detaching them: a click in flight
 * is lost, an iframe reloads, focus and scroll go).
 *
 * alignChildren runs from morphdom's onBeforeElChildrenUpdated, so only for a
 * container morphdom has decided to descend into: everything it skips (focus,
 * an open popover, lvt-ignore, an unchanged node) is never touched. It acts
 * only in the unambiguous case and otherwise leaves the container exactly as
 * main does:
 *
 * - The same tags and author keys in order: positional pairing is already
 *   right. Nothing to do.
 * - Otherwise it trims the run of alike siblings at the front and the back.
 *   If what is left is a pure insertion of plain containers, it puts an empty
 *   placeholder of each new element's tag at its spot, which morphdom fills
 *   in place as an addition. If it is a pure removal, it removes the departing
 *   elements itself, through the client's discard hook, as morphdom would.
 *   Either way it lines the text and comment nodes in that gap up with the
 *   incoming ones, because morphdom pairs those by position too.
 * - The same elements with only text or comments added between them: it adds
 *   empty text or comment nodes where the live side is short, so morphdom
 *   doesn't pair an element with a new text node and rebuild it.
 * - Anything else (a mixed change, a keyed move, the nodes outside the gap not
 *   lining up, a page with a repeated key) is left to morphdom.
 *
 * There are no auto keys: once the live list lines up, morphdom's positional
 * walk pairs it correctly. The only key it hands out is a new author-keyed
 * element's key, to that element's placeholder.
 */

import { authorKey, morphSkips } from "./morph-rules";

/**
 * Plain HTML containers and text tags: inserting one empty and filling it in
 * is the same as inserting it whole. TR, TD and LI are safe here: placeholders
 * are made with createElement, not parsed, so there is no parser context to
 * get wrong. Interactive and replaced elements (BUTTON, A, IMG, INPUT and the
 * like) stay out: they carry focus, activation or loading behaviour, and the
 * list only grows when a tag is known to fill in the same as it inserts.
 */
const PLACEABLE = new Set([
  "DIV", "SECTION", "MAIN", "ASIDE", "HEADER", "FOOTER", "NAV", "ARTICLE",
  "P", "SPAN", "UL", "OL", "LI", "DL", "DT", "DD", "TABLE", "THEAD", "TBODY",
  "TFOOT", "TR", "TD", "TH", "FIELDSET", "LABEL", "BLOCKQUOTE", "PRE",
  "H1", "H2", "H3", "H4", "H5", "H6", "FIGURE", "FIGCAPTION", "STRONG", "EM",
  "SMALL", "CODE", "MARK",
]);

const HTML_NS = "http://www.w3.org/1999/xhtml";

/** What alignChildren needs from the morph it runs in. */
export interface AlignEnv {
  /** Removes a departing live element as morphdom would: discard hook, then removal. */
  discard(el: Element): void;
  /** Whether an author key exists anywhere in the live page. */
  liveHasKey(k: string): boolean;
  /** How many times an author key occurs in the incoming render. */
  incomingKeyCount(k: string): number;
  /**
   * Whether an author key repeats in the live page or the incoming render.
   * morphdom's key lookup keeps only the last copy, so with a duplicate it
   * gets some cases right and some wrong; alignment then stays out entirely.
   */
  hasDuplicateKeys(): boolean;
  /** Records a placeholder, with the author key of its element if it has one. */
  placeholder(ph: Element, key: string | undefined): void;
}

/** The first class token. */
function firstClass(el: Element): string {
  const c = (el.getAttribute("class") || "").trimStart();
  const end = c.search(/\s/);
  return end < 0 ? c : c.slice(0, end);
}

/** Same tag and author key: what morphdom's own pairing looks at. */
function sameShape(a: Element, b: Element): boolean {
  return a.tagName === b.tagName && authorKey(a) === authorKey(b);
}

/**
 * Same tag, author key, id and first class: alike enough to anchor the front
 * and back runs around a change. Ordered so identical attributes decide
 * without building strings.
 */
function alike(a: Element, b: Element): boolean {
  if (!sameShape(a, b)) return false;
  if (a.id !== b.id) return false;
  return a.className === b.className || firstClass(a) === firstClass(b);
}

function elements(el: Element): Element[] {
  const out: Element[] = [];
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) out.push(c);
  return out;
}

/** The node types (E, T, C) from `from` up to, not including, `to`. */
function types(from: ChildNode | null, to: ChildNode | null): string {
  let s = "";
  for (let n = from; n && n !== to; n = n.nextSibling) s += n.nodeType === 1 ? "E" : n.nodeType === 3 ? "T" : "C";
  return s;
}

/** Author keys on el and its descendants. */
function keysUnder(el: Element): string[] {
  const out: string[] = [];
  const own = authorKey(el);
  if (own) out.push(own);
  el.querySelectorAll("[data-key], [data-lvt-key]").forEach((d) => {
    const k = authorKey(d);
    if (k) out.push(k);
  });
  return out;
}

/**
 * Lines one gap of f's children (from liveFrom up to liveEnd) up with the
 * matching gap of the incoming children (inFrom up to inEnd): it reuses the
 * live text and comment nodes in order, adds an empty one where the live side
 * is short, and calls onElement for each incoming element (a placeholder). An
 * extra live text node is harmless: morphdom drops it.
 */
function alignGap(
  f: Element,
  liveFrom: ChildNode | null,
  liveEnd: ChildNode | null,
  inFrom: ChildNode | null,
  inEnd: ChildNode | null,
  onElement: (el: Element, before: Node | null) => void
): void {
  const live: ChildNode[] = [];
  for (let n = liveFrom; n && n !== liveEnd; n = n.nextSibling) live.push(n);
  let k = 0;
  for (let n = inFrom; n && n !== inEnd; n = n.nextSibling) {
    const before: Node | null = k < live.length ? live[k] : liveEnd;
    if (n.nodeType === 1) {
      onElement(n as Element, before);
    } else if (k < live.length && live[k].nodeType === n.nodeType) {
      k++;
    } else {
      const doc = f.ownerDocument;
      f.insertBefore(n.nodeType === 8 ? doc.createComment("") : doc.createTextNode(""), before);
    }
  }
}

/** Aligns f's children with t's in place; see the file comment. */
export function alignChildren(f: Element, t: Element, env: AlignEnv): void {
  // No live elements, or none incoming: no siblings to keep.
  if (!f.firstElementChild || !t.firstElementChild || morphSkips(f, t)) return;
  // The common case, checked by walking both lists in step without building
  // anything: the same tags in order. (Keys aren't read here: with the same
  // tags, differing keys are a reorder or a mixed change, which is left to
  // morphdom's own key matching either way.)
  let a: Element | null = f.firstElementChild;
  let b: Element | null = t.firstElementChild;
  while (a && b && a.tagName === b.tagName) {
    a = a.nextElementSibling;
    b = b.nextElementSibling;
  }
  if (!a && !b) {
    // Same elements. If only text or comments were added between them, line
    // up each gap (empty text nodes only), so no element meets a text node.
    if (f.childNodes.length < t.childNodes.length && !env.hasDuplicateKeys()) {
      const L = elements(f);
      const T = elements(t);
      for (let i = 0; i <= L.length; i++) {
        alignGap(
          f,
          i === 0 ? f.firstChild : L[i - 1].nextSibling,
          i < L.length ? L[i] : null,
          i === 0 ? t.firstChild : T[i - 1].nextSibling,
          i < T.length ? T[i] : null,
          () => {}
        );
      }
    }
    return;
  }
  const L = elements(f);
  const T = elements(t);

  let p = 0;
  while (p < L.length && p < T.length && alike(L[p], T[p])) p++;
  let s = 0;
  while (s < L.length - p && s < T.length - p && alike(L[L.length - 1 - s], T[T.length - 1 - s])) s++;
  const removed = L.slice(p, L.length - s);
  const added = T.slice(p, T.length - s);
  if (removed.length > 0 && added.length > 0) return; // mixed: morphdom's call

  // The nodes outside the gap must already line up, or positional pairing is
  // off anyway and this is not the unambiguous case.
  const liveBefore = p > 0 ? L[p - 1].nextSibling : f.firstChild;
  const liveAfter = s > 0 ? L[L.length - s] : null;
  const inBefore = p > 0 ? T[p - 1].nextSibling : t.firstChild;
  const inAfter = s > 0 ? T[T.length - s] : null;
  if (types(f.firstChild, liveBefore) !== types(t.firstChild, inBefore)) return;
  if (liveAfter && types(liveAfter, null) !== types(inAfter, null)) return;

  if (env.hasDuplicateKeys()) return;
  if (added.length > 0) {
    for (const el of added) {
      if (el.namespaceURI !== HTML_NS || !PLACEABLE.has(el.tagName)) return;
      // A key in the new subtree that is already on the page is a keyed move,
      // which morphdom's lookup does.
      if (keysUnder(el).some((k) => env.liveHasKey(k))) return;
    }
  } else {
    for (const el of removed) {
      // A key in the departing subtree that is still in the render is moving
      // elsewhere, not leaving: morphdom's lookup does that.
      if (keysUnder(el).some((k) => env.incomingKeyCount(k) > 0)) return;
      // main lets an lvt-ignore element survive in another element's slot;
      // stay out rather than change what an ignored element does.
      if (el.hasAttribute("lvt-ignore") || el.querySelector("[lvt-ignore]")) return;
    }
    for (const el of removed) env.discard(el);
  }

  // The gap, node by node, with a placeholder for each new element. (After a
  // removal the gap's first node may have gone with it: start again from the
  // last element before the gap.)
  const start = p > 0 ? L[p - 1].nextSibling : f.firstChild;
  alignGap(f, start, liveAfter, inBefore, inAfter, (tc, before) => {
    const ph = f.ownerDocument.createElement(tc.tagName);
    f.insertBefore(ph, before);
    env.placeholder(ph, authorKey(tc));
  });
}
