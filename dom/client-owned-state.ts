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
 */
export function reapplyClientOwnedState(fromEl: Element, toEl: Element): void {
  const state = ownedState.get(fromEl);
  if (!state) return;

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

  if (state.classes.size === 0 && state.attrs.size === 0) {
    ownedState.delete(fromEl);
  }
}
