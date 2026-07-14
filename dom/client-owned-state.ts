/**
 * Client-owned DOM state — a morph-surviving overlay for `lvt-el:` actions.
 *
 * `lvt-el:toggleClass` / `addClass` / `removeClass` / `setAttr` / `toggleAttr` exist to hold
 * client-side UI state (a dropdown's `open`, a disclosure's `expanded`). The server never emits
 * that state, so the incoming `toEl` carries the server's original `class`/attrs and morphdom's
 * attribute diff overwrites the live element — the menu closes under the user on any unrelated
 * re-render.
 *
 * Copying `fromEl`'s classes onto `toEl` cannot fix this: at morph time `fromEl.classList` is the
 * UNION of the server's tokens and the client's, so copying it would also resurrect classes the
 * server deliberately dropped this render. Hence a record — it answers the one question morphdom
 * cannot: *which of these tokens does the client own?*
 *
 * A WeakMap (not a data-* attribute) is what makes the record itself morph-immune, following
 * `animatedElements` / `scrollResetPriors` in dom/directives.ts. It also leaves no DOM residue and
 * is collected with the element.
 *
 * Semantics — the client overlay wins on conflict, the server reowns on agreement:
 *
 *   - Conflict (client wants a class the server omits, or vice versa) → re-apply onto `toEl`, so
 *     morphdom stamps it onto the live element. The overlay persists until the client reverses it
 *     or the element is discarded.
 *   - Agreement (client and server now want the same thing) → drop the entry; the overlay is
 *     redundant and the server reowns the value.
 *
 * The agreement rule is also what retires an entry when the client toggles back to the server's
 * value — no separate bookkeeping needed. It does mean that once the server emits a value the
 * client had been overlaying, the client's claim is retired for good: if the server later stops
 * emitting it, the value goes away rather than reverting to an overlay. That is intended — once the
 * server has spoken about a value it owns it — and it keeps records from leaking forever.
 *
 * Note this is deliberately NOT gated on the element still carrying its `lvt-el:*` directive, which
 * is how the one-shot guards (`data-lvt-iv-done`, `data-lvt-autofocused`) work. Those are latches
 * that need to re-arm; this is state that needs to persist. A directive gate would also break every
 * `data-lvt-target` binding, whose resolved target carries no `lvt-el:*` attribute at all.
 */

/**
 * One-shot latch guards: runtime-only attributes a directive stamps on the live DOM to record that
 * it has already fired once. The server never emits them, so morphdom strips them on every render
 * unless we copy them onto `toEl` — and the directive then re-fires on every unrelated re-render.
 *
 * Unlike the overlay below, these ARE gated on their directive still being present: they are
 * latches, so when the server drops the directive the guard must fall away and the directive
 * re-arm on re-add (deliberately re-navigating to the same element should scroll again).
 *
 * This is a table rather than an if-chain because the chain was how `data-lvt-scroll-sticky` came
 * to ship broken: it enumerated two of the three guards, and the third was simply forgotten. A new
 * one-shot directive registers a row here instead of hand-writing another branch.
 *
 * (`lvt-fx:animate` needs no row — it latches via a WeakSet, which morphdom cannot touch.)
 */
const ONE_SHOT_GUARDS: ReadonlyArray<{
  /** the runtime-only attribute the directive stamps */
  guard: string;
  /** the value it stamps, and the value we restore */
  value: string;
  /** preserve the guard only while this directive is still on the element */
  directive: string;
  /**
   * ...and, when the directive's VALUE selects a mode, only while that mode is still selected.
   * Two lvt-fx:scroll modes latch separately (into-view and bottom-sticky), so presence of
   * `lvt-fx:scroll` alone is not enough: if a node switched modes, matching on presence would
   * carry the old mode's guard over and stop the directive re-arming when the mode came back.
   */
  directiveValue?: string;
}> = [
  // lvt-fx:scroll="into-view" — else a background poll re-scrolls the viewport to a stale target.
  { guard: "data-lvt-iv-done", value: "1", directive: "lvt-fx:scroll", directiveValue: "into-view" },
  // lvt-autofocus — else any render re-steals focus. Valueless: presence is the whole directive.
  { guard: "data-lvt-autofocused", value: "true", directive: "lvt-autofocus" },
  // lvt-fx:scroll="bottom-sticky" — else every render force-jumps a scrolled-up reader to the
  // bottom (behavior:"instant"), making the near-bottom threshold check dead code.
  { guard: "data-lvt-scroll-sticky", value: "1", directive: "lvt-fx:scroll", directiveValue: "bottom-sticky" },
];

/** Copy any still-armed one-shot guards onto `toEl` so morphdom keeps them. */
export function preserveOneShotGuards(fromEl: Element, toEl: Element): void {
  for (const { guard, value, directive, directiveValue } of ONE_SHOT_GUARDS) {
    if (fromEl.getAttribute(guard) !== value) continue;
    const stillArmed =
      directiveValue === undefined
        ? toEl.hasAttribute(directive)
        : toEl.getAttribute(directive) === directiveValue;
    if (stillArmed) {
      toEl.setAttribute(guard, value);
    }
  }
}

interface OwnedState {
  /** class → true if the client added it, false if the client removed it. */
  classes: Map<string, boolean>;
  /** attribute name → the value the client set, or null if the client removed it. */
  attrs: Map<string, string | null>;
}

const ownedState = new WeakMap<Element, OwnedState>();

function stateFor(element: Element): OwnedState {
  let state = ownedState.get(element);
  if (!state) {
    state = { classes: new Map(), attrs: new Map() };
    ownedState.set(element, state);
  }
  return state;
}

/** Record that the client added (or removed) a class, so it survives the next morph. */
export function recordClass(element: Element, className: string, added: boolean): void {
  stateFor(element).classes.set(className, added);
}

/**
 * Record that the client set an attribute to `value`, or removed it when `value` is null.
 * Boolean attributes set via toggleAttr are recorded with their DOM value, the empty string.
 */
export function recordAttr(element: Element, name: string, value: string | null): void {
  stateFor(element).attrs.set(name, value);
}

/**
 * Re-apply an element's client-owned state onto the incoming `toEl`, from onBeforeElUpdated.
 *
 * Writing to `toEl` rather than `fromEl` is the whole trick: morphdom calls onBeforeElUpdated
 * BEFORE morphAttrs(fromEl, toEl), and morphAttrs copies toEl's attributes ONTO the live element.
 * So whatever we put on `toEl` here is what morphdom stamps onto the live DOM.
 *
 * Entries that the server has come to agree with are dropped as we go (see the file header).
 *
 * Attributes are applied BEFORE classes on purpose: a whole-attribute write (`lvt-el:setAttr`
 * with name `class`) replaces the class list wholesale, so it has to land first and let the
 * per-token class overlay layer on top. The other order would let setAttr stomp the classes the
 * overlay had just restored.
 */
export function reapplyClientOwnedState(fromEl: Element, toEl: Element): void {
  const state = ownedState.get(fromEl);
  if (!state) return;

  for (const [name, value] of state.attrs) {
    // getAttribute already returns null for an absent attribute, which is exactly how a
    // client-side removal is recorded — so the two representations compare directly.
    if (toEl.getAttribute(name) === value) {
      state.attrs.delete(name); // server agrees — it reowns the attribute
      continue;
    }
    if (value === null) {
      toEl.removeAttribute(name);
    } else {
      toEl.setAttribute(name, value);
    }
  }

  for (const [className, added] of state.classes) {
    if (toEl.classList.contains(className) === added) {
      state.classes.delete(className); // server agrees — it reowns the class
      continue;
    }
    if (added) {
      toEl.classList.add(className);
    } else {
      toEl.classList.remove(className);
    }
  }

  if (state.classes.size === 0 && state.attrs.size === 0) {
    ownedState.delete(fromEl);
  }
}
