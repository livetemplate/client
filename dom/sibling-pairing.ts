/**
 * Pair unkeyed sibling elements by what they are, not where they are, before
 * morphdom runs.
 *
 * morphdom pairs unkeyed siblings by position, matching on tag name alone. So
 * when a conditional puts an element in front of unkeyed siblings, it morphs
 * each sibling into the one before it and builds a fresh copy of the last,
 * moving keyed descendants into that copy (detaching them: a click in flight is
 * lost, an iframe reloads, focus and scroll go).
 *
 * pairSiblings walks the live tree and the incoming tree together, from the
 * root down through the pairs it makes:
 *
 * - Where a sibling list keeps the same signatures in the same order, morphdom's
 *   positional pairing is already right, so it only recurses. This is the
 *   common case and allocates nothing.
 * - Elsewhere it pairs unkeyed siblings whose signature is unique on both
 *   sides, then pairs what is left by tag with a spare live element that keeps
 *   the pairs in order, and gives each pair a shared key for getNodeKey. The
 *   signature is the tag, the id and the first
 *   class token: modifier classes come and go (a template's `{{if}} is-open`,
 *   a class the client toggles), and such an element is still the same one.
 * - Keys alone don't stop moves: morphdom appends a new unmatched element at
 *   the end, then moves every keyed sibling after it back into order,
 *   detaching each. So a new element that comes before a paired sibling gets
 *   an empty placeholder of its tag at that spot in the live tree, keyed to it.
 *   morphdom fills the placeholder in place, and the caller treats that as an
 *   addition (see Pairing.placeholders). Only plain container tags get one: an
 *   element that acts when inserted or filled (a script, an iframe, a form
 *   control, a custom element, SVG) keeps morphdom's own handling.
 *
 * The keys live only in the returned map; the placeholders are the only DOM
 * writes.
 */

import { authorKey, morphSkips } from "./morph-rules";

/**
 * Plain HTML containers and text tags: inserting one empty and filling it in
 * is the same as inserting it whole. TR, TD and LI are safe here: placeholders
 * are made with createElement, not parsed, so there is no parser context to
 * get wrong.
 */
const PLACEABLE = new Set([
  "DIV", "SECTION", "MAIN", "ASIDE", "HEADER", "FOOTER", "NAV", "ARTICLE",
  "P", "SPAN", "UL", "OL", "LI", "DL", "DT", "DD", "TABLE", "THEAD", "TBODY",
  "TFOOT", "TR", "TD", "TH", "FIELDSET", "LABEL", "BLOCKQUOTE", "PRE",
  "H1", "H2", "H3", "H4", "H5", "H6", "FIGURE", "FIGCAPTION", "STRONG", "EM",
  "SMALL", "CODE", "MARK",
]);

const HTML_NS = "http://www.w3.org/1999/xhtml";

/** The first class token. */
function firstClass(el: Element): string {
  const c = (el.getAttribute("class") || "").trimStart();
  const end = c.search(/\s/);
  return end < 0 ? c : c.slice(0, end);
}

function signature(el: Element): string {
  return el.tagName + "#" + (el.getAttribute("id") || "") + "." + firstClass(el);
}

/**
 * Same author key, or both unkeyed with the same signature. Ordered so the
 * common case (identical attributes) decides without building strings: this
 * runs for every element pair on every update.
 */
function alike(a: Element, b: Element): boolean {
  if (a.tagName !== b.tagName) return false;
  const ka = authorKey(a);
  if (ka !== authorKey(b)) return false;
  if (ka !== undefined) return true;
  if (a.id !== b.id) return false;
  // className is a string on HTML elements (an SVGAnimatedString on SVG ones,
  // which never compares equal here and falls through to the attribute).
  return a.className === b.className || firstClass(a) === firstClass(b);
}

export interface Pairing {
  /**
   * The shared key of each paired element, on both sides; null if none. An
   * author key where the pair has one, else a fresh Symbol, which can never
   * equal an author key (morphdom uses keys only as lookup-object properties
   * and with ===).
   */
  keys: WeakMap<Element, string | symbol> | null;
  /** Placeholders inserted into the live tree, for morphdom to fill. */
  placeholders: Element[];
}

/**
 * pairSiblings pairs the children of `from` (the live DOM) and `to` (the
 * incoming render), recursively. Keys are unique across the whole call, as
 * morphdom looks keyed nodes up tree-wide.
 */
export function pairSiblings(from: Element, to: Element): Pairing {
  let keys: WeakMap<Element, string | symbol> | null = null;
  const placeholders: Element[] = [];
  // The author keys anywhere in the live tree, read only when a keyed new
  // element needs a placeholder: a key that already exists elsewhere is a
  // keyed move, and morphdom must find the real node, not a placeholder. A
  // snapshot is enough: placeholders carry no key attributes, and nothing
  // here adds or changes a keyed live node.
  let liveKeys: Set<string> | null = null;
  const keyedLive = (k: string): boolean => {
    if (!liveKeys) {
      liveKeys = new Set();
      for (const el of Array.from(from.querySelectorAll("[data-key], [data-lvt-key]"))) {
        const ak = authorKey(el);
        if (ak) liveKeys.add(ak);
      }
    }
    return liveKeys.has(k);
  };
  const key = (a: Element, b: Element, k: string | symbol = Symbol("sibling pair")): void => {
    keys = keys || new WeakMap();
    keys.set(a, k);
    keys.set(b, k);
  };

  const walk = (f: Element, t: Element): void => {
    if (!f.firstElementChild || !t.firstElementChild || morphSkips(f, t)) return;

    // Same signatures in the same order: positional pairing is right here.
    let a: Element | null = f.firstElementChild;
    let b: Element | null = t.firstElementChild;
    while (a && b && alike(a, b)) {
      a = a.nextElementSibling;
      b = b.nextElementSibling;
    }
    if (!a && !b) {
      a = f.firstElementChild;
      b = t.firstElementChild;
      for (; a && b; a = a.nextElementSibling, b = b.nextElementSibling) walk(a, b);
      return;
    }
    reshaped(f, t);
  };

  // A sibling list that gained, lost or reordered elements.
  const reshaped = (f: Element, t: Element): void => {
    const fromKids = Array.from(f.children);
    const toKids = Array.from(t.children);
    const fromKeys = fromKids.map(authorKey);
    const toKeys = toKids.map(authorKey);
    const partner = new Map<Element, Element>(); // to child -> its live partner
    const pairedFrom = new Set<Element>();
    const pair = (fc: Element, tc: Element, authored?: string): void => {
      partner.set(tc, fc);
      pairedFrom.add(fc);
      if (!authored) key(fc, tc); // author-keyed pairs already match by key
    };

    // Author keys first, then signatures unique on both sides. A key that
    // repeats among siblings is already a template bug; the last one pairs and
    // the others are treated as departing.
    const byKey = new Map<string, Element>();
    fromKids.forEach((c, i) => {
      const k = fromKeys[i];
      if (k) byKey.set(k, c);
    });
    toKids.forEach((c, i) => {
      const k = toKeys[i];
      const fc = k ? byKey.get(k) : undefined;
      if (fc) pair(fc, c, k);
    });
    const unique = (kids: Element[], ks: (string | undefined)[]): Map<string, Element | null> => {
      const m = new Map<string, Element | null>();
      kids.forEach((c, i) => {
        if (ks[i]) return;
        const s = signature(c);
        m.set(s, m.has(s) ? null : c);
      });
      return m;
    };
    const fromSig = unique(fromKids, fromKeys);
    for (const [s, tc] of unique(toKids, toKeys)) {
      const fc = fromSig.get(s);
      if (tc && fc) pair(fc, tc);
    }

    // What is left pairs by tag with a spare live element between its paired
    // neighbours' partners: the element morphdom would have reused anyway.
    // Pairs must not cross: morphdom moves whatever is out of order, and that
    // detaches it. With no spare in range the element is new.
    const fromIndex = new Map<Element, number>();
    fromKids.forEach((c, i) => fromIndex.set(c, i));
    const nextPartner: number[] = new Array(toKids.length);
    for (let i = toKids.length - 1, hi = fromKids.length; i >= 0; i--) {
      nextPartner[i] = hi;
      const fc = partner.get(toKids[i]);
      if (fc) hi = fromIndex.get(fc)!;
    }
    let lo = -1;
    toKids.forEach((c, i) => {
      const fc = partner.get(c);
      if (fc) {
        lo = fromIndex.get(fc)!;
        return;
      }
      if (toKeys[i]) return;
      for (let j = lo + 1; j < nextPartner[i]; j++) {
        const cand = fromKids[j];
        if (!fromKeys[j] && !pairedFrom.has(cand) && cand.tagName === c.tagName) {
          pair(cand, c);
          lo = j;
          return;
        }
      }
    });

    // Recurse into the pairs.
    const order: number[] = [];
    toKids.forEach((tc) => {
      const fc = partner.get(tc);
      if (fc) {
        walk(fc, tc);
        order.push(fromIndex.get(fc)!);
      }
    });
    // Pairs out of order are a real reorder: morphdom moves them, as it should,
    // so each element keeps its state (before, positional pairing morphed one
    // sibling's content into another's node).
    if (order.some((x, k) => k > 0 && x < order[k - 1])) return;
    align(f, t, partner, pairedFrom);
  };

  // align makes each gap between paired siblings in the live tree line up,
  // node by node, with the same gap in the incoming one. morphdom pairs text
  // nodes by position too: where the incoming side has a text node and the
  // live side an element, it sets the element aside and moves it back later,
  // detaching it. So within each gap:
  // - a new element gets a placeholder (plain containers only);
  // - every incoming text or comment node gets one in the live tree, reusing
  //   the live ones in order and adding empty ones where short (an extra live
  //   one is harmless: morphdom drops it);
  // - departing live elements move to the end, where morphdom removes them as
  //   usual (lifecycle hooks and all) without passing them on the way. The
  //   move disconnects and reconnects them first (a custom element's
  //   callbacks run, an iframe inside reloads), which is harmless for an
  //   element on its way out; lvt-destroyed doesn't depend on position. This
  //   relies on removals not being vetoed: the client's onBeforeNodeDiscarded
  //   always allows them, so a departing element is gone by the end of the
  //   same morph, as it was before.
  const align = (
    f: Element,
    t: Element,
    partner: Map<Element, Element>,
    pairedFrom: Set<Element>
  ): void => {
    const departing: Element[] = [];
    let live: ChildNode | null = f.firstChild;
    let gap: ChildNode[] = [];
    const flush = (end: Element | null): void => {
      const texts: ChildNode[] = [];
      for (; live && live !== end; live = live.nextSibling) {
        if (live.nodeType === 1) {
          if (!pairedFrom.has(live as Element)) departing.push(live as Element);
        } else {
          texts.push(live);
        }
      }
      let k = 0;
      for (const n of gap) {
        const before: Node | null = k < texts.length ? texts[k] : end;
        if (n.nodeType === 1) {
          const tc = n as Element;
          const ak = authorKey(tc);
          const placeable = end && tc.namespaceURI === HTML_NS && PLACEABLE.has(tc.tagName);
          if (placeable && !(ak && keyedLive(ak))) {
            const ph = f.ownerDocument.createElement(tc.tagName);
            f.insertBefore(ph, before);
            key(ph, tc, ak);
            placeholders.push(ph);
          }
        } else if (k < texts.length && texts[k].nodeType === n.nodeType) {
          k++;
        } else {
          const doc = f.ownerDocument;
          f.insertBefore(n.nodeType === 8 ? doc.createComment("") : doc.createTextNode(""), before);
        }
      }
      gap = [];
      if (end) live = end.nextSibling;
    };
    for (let n: ChildNode | null = t.firstChild; n; n = n.nextSibling) {
      const fc = n.nodeType === 1 ? partner.get(n as Element) : undefined;
      if (fc) flush(fc);
      else gap.push(n);
    }
    flush(null);
    for (const d of departing) f.appendChild(d);
  };

  walk(from, to);
  return { keys, placeholders };
}
