/**
 * LiveTemplate attribute handler registry.
 *
 * The public extension point for `lvt-*` attributes. Instead of the core client
 * hardcoding a call to every handler it knows about, handlers register
 * themselves here and the post-render loop scans the registry.
 *
 * Two layers, both of them `AttributeHandler`:
 *
 *   DECLARATIVE — declare an attribute NAME. The framework escapes it, scans
 *   for it, tracks which elements match, reads the value, and sweeps elements
 *   that lost it. This is what most authors should use; it makes the three
 *   classic mistakes (no sweep, non-idempotent wiring, a stale captured `send`)
 *   impossible by construction.
 *
 *   LOW-LEVEL — supply `selectors` + `setup()`/`teardown()`. The escape hatch
 *   for handlers with cross-element state, multi-attribute matches, or
 *   selectors that aren't a plain attribute-presence match. Every built-in uses
 *   this layer, because each one predates the registry and keeps its own body.
 *
 * REGISTRATION IS MODULE-LEVEL AND STATIC, never instance-scoped, and late
 * registration is a supported path — a second bundle can only evaluate after
 * the core bundle has already auto-initialized and connected, so there is no
 * instance for it to call a method on. See `docs/plans/issue-473.md` § Design 2
 * ("Bootstrap timing") in the livetemplate repo for the full argument.
 *
 * WHAT THE REGISTRY CAN ANSWER ABOUT ITSELF. A declarative handler's
 * `attribute` is authoritative: it is a plain name, the framework owns the
 * scan, and comparing it against the server's attribute census is a string
 * match. A low-level handler's `selectors` is NOT authoritative — it is
 * author-supplied prose that the loop never reads, and two built-ins
 * (`setupFxDOMEventTriggers`, the `lvt-el:` delegator) legitimately scan
 * `querySelectorAll("*")` and so claim no attribute at all. Low-level handlers
 * are therefore excluded from the attribute-census comparison that Phase 3
 * ships, and from the duplicate-registration warning below.
 */

import { lvtSelector } from "./utils/lvt-selector";
import { createLogger } from "./utils/logger";

const logger = createLogger({ scope: "AttributeRegistry" });

/**
 * Dispatches a server action through the client's live transport. Identical to
 * the path an `lvt-on:click` action takes — a custom attribute's action is
 * indistinguishable from a built-in one by the time it reaches the server.
 */
export type SendFn = (message: { action: string; data: Record<string, unknown> }) => void;

/**
 * When a handler runs, relative to the post-render pipeline.
 *
 *   fire-on-change   — every render. For handlers reacting to a VALUE changing
 *                      on an element that already exists (a highlight flash, a
 *                      scroll-to, a re-read of the attribute).
 *   wire-idempotent  — only when morphdom added nodes or touched a directive
 *                      attribute. For handlers that walk many descendants to
 *                      attach listeners; skipping saves ~150-200ms per render
 *                      at 80k nodes.
 *   always           — every render, unconditionally, including renders a
 *                      future optimization might skip. For handlers that must
 *                      process REMOVALS, not just current matches.
 *
 * `always` and `fire-on-change` are indistinguishable today, because `updateDOM`
 * runs its post-render block unconditionally — there is no empty-diff skip to
 * be exempt from. The distinction is kept because it records intent: if such a
 * skip ever lands, `always` is the category that must not be caught by it.
 */
export type HandlerCategory = "always" | "fire-on-change" | "wire-idempotent";

interface BaseHandler {
  /** Defaults to `attribute` for declarative handlers; required for low-level. */
  name?: string;

  /**
   * Omit to derive: declaring `onElement` => "fire-on-change"; only
   * `onElementAdded`/`onElementRemoved` => "wire-idempotent". An explicit
   * value always wins.
   */
  category?: HandlerCategory;

  /** Whether this handler dispatches server actions. Default false. */
  needsServerChannel?: boolean;

  /**
   * Root-less cleanup, run on every disconnect whether or not a wrapper
   * element exists.
   *
   * `teardown(root)` can only express cleanup scoped to a subtree, but plenty
   * of handlers own module-global state — a timer map, a document-level
   * listener — that has no root to be scoped to. Without this hook such a
   * handler's cleanup has to stay a hardcoded call in the core client, which
   * makes it unrelocatable and the registry a half-interface.
   */
  dispose?(): void;

  // Reserved: per-element morphdom predicates (onBeforeElUpdated?, ...).
  // Deferred, not designed. Every extension point on this interface is an
  // OPTIONAL member by construction, so adding one stays a minor release.
}

/**
 * Per-element context handed to a declarative handler's callbacks.
 *
 * Both members are LIVE ACCESSORS, deliberately. Capturing `ctx` inside a
 * listener is the normal thing to do, so reading it later has to be correct:
 *
 *   - `value` re-reads the attribute, so a server re-render is picked up rather
 *     than the callback holding the value it saw at wiring time;
 *   - `send` resolves the current transport, so a captured `ctx` survives a
 *     WebSocket reconnect instead of dispatching into a dead socket.
 */
export interface ElementContext {
  readonly value: string;
  readonly send?: SendFn;
  readonly wrapperRoot: Element;
}

/** Context handed to a low-level handler's `setup()`. */
export interface SetupContext {
  /** Element subtree to scan. */
  scanRoot: Element;
  /** Top-level wrapper, for event-listener storage keyed per wrapper. */
  wrapperRoot: Element;
  /** Only provided when `needsServerChannel` is true. */
  send?: SendFn;
}

export interface DeclarativeHandler extends BaseHandler {
  /**
   * A plain attribute name, e.g. "lvt-x:copy". Never a CSS selector.
   *
   * An element is claimed while it carries this attribute WITH a non-empty
   * value. Emptying the value is treated exactly like removing the attribute:
   * the value is the handler's configuration, so an empty one means unarmed,
   * and `onElementRemoved` fires.
   */
  attribute: string;
  selectors?: undefined;

  /** Once per element, the first time it matches. */
  onElementAdded?(el: Element, ctx: ElementContext): void;
  /** Every run, for every currently matching element. */
  onElement?(el: Element, ctx: ElementContext): void;
  /**
   * The element detached, or its attribute was removed or emptied by a server
   * diff. Fires on every render — it is never deferred by `category`.
   *
   * Requires `onElementAdded` or `onElement`: elements are only tracked when
   * one of those claims them, so this callback on its own could never fire.
   * Registration rejects that shape rather than accepting a handler that does
   * nothing forever.
   */
  onElementRemoved?(el: Element): void;
}

export interface LowLevelHandler extends BaseHandler {
  /** Descriptive only — see the file header. e.g. '[lvt-fx\\:scroll]'. */
  selectors: string[];
  attribute?: undefined;

  setup(ctx: SetupContext): void;
  teardown?(root: Element): void;
}

export type AttributeHandler = DeclarativeHandler | LowLevelHandler;

export function isDeclarative(h: AttributeHandler): h is DeclarativeHandler {
  return typeof (h as DeclarativeHandler).attribute === "string";
}

/**
 * A live client, from the registry's point of view. Clients attach on connect
 * and detach on disconnect so that late registration has somewhere to catch up
 * to, without the registry importing the client class.
 */
export interface RegistryRoot {
  /** The client's wrapper, read at call time — it is replaced on navigation. */
  root(): Element | null;
  send: SendFn;
}

const registry: AttributeHandler[] = [];
const liveRoots = new Set<RegistryRoot>();

/**
 * Per-handler element tracking for the declarative layer.
 *
 * The VALUE is an enumerable Map, not a WeakMap, because sweeping requires
 * ENUMERATING what matched before — a WeakMap can answer "is this element
 * tracked?" but not "which tracked elements are gone?". The cost is that a
 * detached element stays reachable until the next sweep drops it, and since
 * sweeps run on every render regardless of category, that window is one
 * render for every handler.
 *
 * The value cached against each element is its `ElementContext`, built once for
 * the element's lifetime. Rebuilding it per render would allocate an object and
 * three accessor closures for every match on every render — on a 10k-row table
 * with one custom attribute per row, ~40k allocations a render — and would buy
 * nothing: the context's members are accessors precisely so a single instance
 * stays correct as the value, transport and wrapper change beneath it.
 */
const tracked = new WeakMap<AttributeHandler, Map<Element, ElementContext>>();

/**
 * The transport each handler's contexts should currently dispatch through.
 *
 * Kept OUTSIDE the context object on purpose. A handler wires a listener in
 * `onElementAdded` and that listener captures the `ctx` it was handed — once,
 * on the render the element first appeared. A reconnect rebuilds the transport,
 * so a context that closed over the send it was constructed with would keep
 * dispatching into the dead one for the rest of the page's life. Storing the
 * send here and reading it through the accessor means every captured context
 * follows the reconnect, which is the guarantee `ElementContext` documents.
 */
const currentSend = new WeakMap<AttributeHandler, SendFn>();

/**
 * The roots of the dispatch currently in flight, per handler.
 *
 * Exists for the same reason as `currentSend`: a cached `ElementContext` must
 * report the wrapper of the render being processed, not the one that happened
 * to be live when the element was first seen. Cross-handler navigation
 * replaces the wrapper.
 */
const currentRoots = new WeakMap<AttributeHandler, { scanRoot: Element; wrapperRoot: Element }>();

/**
 * Values fixed at registration, computed once instead of per render: the
 * resolved category (`shouldRun` asks 19 times a render otherwise) and, for a
 * declarative handler, its escaped attribute selector.
 */
const resolved = new WeakMap<AttributeHandler, { category: HandlerCategory; selector: string }>();

/**
 * Elements already warned about for an empty attribute value.
 *
 * The empty-value check runs on every render (an element with no value is
 * deliberately never tracked, so it can heal the moment a real value arrives),
 * which without this would emit one warning per render for as long as the
 * element persists — once per keystroke on a template that re-renders on
 * input. Cleared when the element heals, so a value that empties again is
 * reported again.
 */
const warnedEmpty = new WeakSet<Element>();

function trackedMap(handler: AttributeHandler): Map<Element, ElementContext> {
  let map = tracked.get(handler);
  if (!map) {
    map = new Map<Element, ElementContext>();
    tracked.set(handler, map);
  }
  return map;
}

/** Resolved display name, for warnings. */
function handlerName(h: AttributeHandler): string {
  return h.name || (isDeclarative(h) ? h.attribute : h.selectors.join(","));
}

/**
 * What a handler CLAIMS, for the duplicate-registration warning, or null if it
 * claims nothing checkable.
 *
 * Never `selectors`: that field is descriptive (the loop dispatches by calling
 * `setup()` and never reads it), and two built-ins legitimately scan
 * `querySelectorAll("*")`, so keying the warning on it would make the registry
 * warn about its own core handlers on every page load.
 */
function claimKey(h: AttributeHandler): string | null {
  if (isDeclarative(h)) return h.attribute.toLowerCase();
  return h.name ? h.name.toLowerCase() : null;
}

/**
 * The category a handler runs under, derived when not declared.
 *
 * Declarative: `onElement` means "react to a value that can change on an
 * element that already exists", which only works if the handler runs every
 * render. Wiring-only handlers (`onElementAdded`/`onElementRemoved`) would do
 * nothing on an unchanged DOM, so they earn the skip.
 *
 * Low-level: there is nothing to derive from, so an omitted category means
 * "fire-on-change" — the conservative default, because running too often is a
 * performance bug while running too rarely is a correctness bug. A low-level
 * handler that can afford the skip has to say so explicitly.
 */
export function resolveCategory(h: AttributeHandler): HandlerCategory {
  const cached = resolved.get(h);
  if (cached) return cached.category;
  return deriveCategory(h);
}

function deriveCategory(h: AttributeHandler): HandlerCategory {
  if (h.category) return h.category;
  if (isDeclarative(h)) {
    return h.onElement ? "fire-on-change" : "wire-idempotent";
  }
  return "fire-on-change";
}

/** Whether a handler runs for a render with this much change in it. */
export function shouldRun(h: AttributeHandler, domChanged: boolean): boolean {
  return resolveCategory(h) !== "wire-idempotent" || domChanged;
}

/**
 * Registers an attribute handler.
 *
 * Static by design (see the file header). Registering after a client already
 * exists immediately runs the handler against every live wrapper, so a bundle
 * that loads after core participates from the current render rather than
 * silently doing nothing until the user happens to trigger the next one.
 */
export function registerAttribute(handler: AttributeHandler): void {
  if (!handler || typeof handler !== "object") {
    logger.warn("registerAttribute: expected a handler object, got", handler);
    return;
  }

  const declarative = isDeclarative(handler);
  if (declarative && (handler as any).selectors) {
    logger.warn(
      `registerAttribute("${handlerName(handler)}"): a handler declares either ` +
        `\`attribute\` (declarative) or \`selectors\` (low-level), never both. Ignored.`
    );
    return;
  }
  if (
    !declarative &&
    (!Array.isArray((handler as LowLevelHandler).selectors) ||
      typeof (handler as LowLevelHandler).setup !== "function")
  ) {
    logger.warn(
      "registerAttribute: a handler declares either an `attribute` name (declarative) " +
        "or a `selectors` array with a setup() function (low-level). Ignored."
    );
    return;
  }

  // Duplicate claim warning. Keyed on the DECLARATIVE attribute name and on the
  // resolved handler name — never on `selectors`, which is descriptive and
  // which two built-ins legitimately set to a bare "*" walk. Case-folded
  // because HTML parsers ASCII-lowercase attribute names, so `lvt-x:doThing`
  // and `lvt-x:dothing` are the same attribute in the DOM even though they are
  // different strings here.
  const key = claimKey(handler);
  const clash = key !== null && registry.some((existing) => claimKey(existing) === key);
  if (clash) {
    logger.warn(
      `registerAttribute("${handlerName(handler)}"): another handler already claims this ` +
        `name. Both will run; the earlier registration is not replaced. Third-party ` +
        `attributes should avoid the lvt-fx:/lvt-el:/lvt-form: namespaces.`
    );
  }

  if (declarative) {
    const d = handler as DeclarativeHandler;
    // A declarative handler is tracked by the scan, and the scan only runs for
    // handlers with something to call on a match. So onElementRemoved on its
    // own can never fire: nothing is ever tracked, so nothing is ever swept.
    // All three callbacks are optional, so this shape type-checks — which makes
    // rejecting it loudly the only thing standing between the author and a
    // handler that does nothing forever.
    if (!d.onElementAdded && !d.onElement) {
      logger.warn(
        `registerAttribute("${handlerName(handler)}"): a declarative handler needs ` +
          `onElementAdded or onElement — ` +
          (d.onElementRemoved
            ? `onElementRemoved alone can never fire, because elements are only tracked when one of the other two claims them.`
            : `it declares no callbacks at all.`) +
          ` Ignored.`
      );
      return;
    }
  }

  let selector = "";
  if (declarative) {
    selector = lvtSelector((handler as DeclarativeHandler).attribute);
    // Validate ONCE, here, rather than discovering it on every render.
    // lvtSelector escapes ':' — the character that actually appears in lvt-*
    // names — but a name containing ']' or a quote would close the attribute
    // selector early and make querySelectorAll throw SyntaxError on every
    // render for the life of the page. Rejecting at registration turns a
    // recurring render-time crash into one warning the author can act on.
    try {
      document.createDocumentFragment().querySelector(selector);
    } catch {
      logger.warn(
        `registerAttribute("${handlerName(handler)}"): not a usable attribute name — ` +
          `it does not form a valid CSS attribute selector (${selector}). Ignored.`
      );
      return;
    }
  }

  resolved.set(handler, { category: deriveCategory(handler), selector });

  registry.push(handler);

  // Late-registration catch-up.
  //
  // Deliberately NOT gated on `shouldRun`: category answers "did this render
  // change enough to be worth re-running?", and registration is not a render.
  // A handler that has never run has everything to do, whatever its category.
  for (const liveRoot of liveRoots) {
    const root = liveRoot.root();
    if (!root) continue;
    runHandler(handler, { scanRoot: root, wrapperRoot: root }, liveRoot.send);
  }
}

/** The live registry. Read on every render, never snapshotted at construction. */
export function getRegisteredAttributes(): readonly AttributeHandler[] {
  return registry;
}

/**
 * Test-only: empties the registry and detaches every live root.
 *
 * Element tracking is not cleared and does not need to be: it is keyed by
 * handler object, so a discarded handler's entry is unreachable.
 */
export function __resetRegistryForTesting(): void {
  registry.length = 0;
  liveRoots.clear();
}

/** Attaches a live client so late registration has somewhere to catch up to. */
export function attachRegistryRoot(root: RegistryRoot): void {
  liveRoots.add(root);
}

export function detachRegistryRoot(root: RegistryRoot): void {
  liveRoots.delete(root);
}

/**
 * Runs one handler against one root. `send` is passed separately from the
 * context so it can be withheld from handlers that didn't ask for it — a
 * handler without `needsServerChannel` never sees a transport.
 */
export function runHandler(
  handler: AttributeHandler,
  roots: { scanRoot: Element; wrapperRoot: Element },
  send: SendFn,
  domChanged = true
): void {
  const channel = handler.needsServerChannel ? send : undefined;
  if (channel && currentSend.get(handler) !== channel) currentSend.set(handler, channel);

  if (!isDeclarative(handler)) {
    if (!shouldRun(handler, domChanged)) return;
    // setup() is third-party code on the public path, so it gets the same
    // isolation as every other hook: one handler throwing must not strand the
    // handlers registered after it, nor abort the rest of the render (the
    // event delegator, the upload wiring and the change auto-wirer all run
    // after this loop).
    try {
      handler.setup({ scanRoot: roots.scanRoot, wrapperRoot: roots.wrapperRoot, send: channel });
    } catch (error) {
      reportHookError(handler, "setup", error);
    }
    return;
  }

  // A declarative handler ALWAYS sweeps, whatever its category, and scans only
  // when the render earned it. The two halves have opposite cost profiles and
  // opposite failure modes:
  //
  //   sweep — O(tracked) with two O(1) reads per element. Skipping it leaves a
  //           disarmed element holding its listeners, which is a correctness
  //           bug and the single most common failure in the hardcoded handlers
  //           this registry replaced.
  //   scan  — a querySelectorAll walk. Skipping it costs nothing when nothing
  //           was added, which is exactly what `wire-idempotent` is for.
  //
  // Gating both on the category broke the most natural handler shape there is:
  // onElementAdded + onElementRemoved derives `wire-idempotent`, so removal
  // notifications were deferred to the next render that happened to add a node.
  // Worse, the flag can never see the render that matters — the morphdom hook
  // that sets `directiveTouchedThisRender` inspects the NEW element's
  // attributes, so it detects an attribute being added and never one being
  // removed.
  const seen = trackedMap(handler);
  currentRoots.set(handler, roots);
  sweep(handler, seen);

  if (!shouldRun(handler, domChanged)) return;
  dispatchDeclarative(handler, roots, seen);
}

/**
 * Runs a list of handlers against one root, skipping those the render did not
 * earn.
 *
 * The gate and the dispatch belong together: exporting only the two halves
 * invites every caller — including tests — to hand-copy the loop that joins
 * them, and a hand-copied loop in a test silently stops pinning the production
 * one the moment either changes.
 */
export function runHandlers(
  handlers: readonly AttributeHandler[],
  roots: { scanRoot: Element; wrapperRoot: Element },
  send: SendFn,
  domChanged: boolean
): void {
  for (const handler of handlers) {
    runHandler(handler, roots, send, domChanged);
  }
}

/**
 * Runs every handler's root-less cleanup. Called unconditionally on disconnect,
 * including when there is no wrapper element to scope a teardown to.
 */
export function disposeHandlers(handlers: readonly AttributeHandler[]): void {
  for (const handler of handlers) {
    if (!handler.dispose) continue;
    try {
      handler.dispose();
    } catch (error) {
      reportHookError(handler, "dispose", error);
    }
  }
}

/**
 * Runs the teardown side of one handler against one root.
 *
 * For a declarative handler this means sweeping every tracked element, which is
 * what makes `onElementRemoved` a reliable cleanup hook rather than a
 * best-effort one.
 */
export function teardownHandler(handler: AttributeHandler, root: Element): void {
  if (!isDeclarative(handler)) {
    handler.teardown?.(root);
    return;
  }
  const map = trackedMap(handler);
  if (!handler.onElementRemoved && map.size === 0) return;
  for (const el of Array.from(map.keys())) {
    if (root.contains(el) || !el.isConnected) {
      map.delete(el);
      notifyRemoved(handler, el);
    }
  }
}

/**
 * A third-party callback throwing must not abort the render or strand the
 * handlers registered after it — the registry is a public extension point, so
 * other people's code runs in this loop.
 */
function reportHookError(handler: AttributeHandler, hook: string, error: unknown): void {
  logger.error(`${handlerName(handler)}.${hook}() threw:`, error);
}

function notifyRemoved(handler: DeclarativeHandler, el: Element): void {
  if (!handler.onElementRemoved) return;
  try {
    handler.onElementRemoved(el);
  } catch (error) {
    reportHookError(handler, "onElementRemoved", error);
  }
}

function dispatchDeclarative(
  handler: DeclarativeHandler,
  roots: { scanRoot: Element; wrapperRoot: Element },
  seen: Map<Element, ElementContext>
): void {
  const attribute = handler.attribute;

  // Hoisted: a wiring-only handler declares no onElement, and checking that
  // per element per render costs a branch and a closure for nothing.
  const wantsAdded = !!handler.onElementAdded;
  const wantsEvery = !!handler.onElement;
  if (!wantsAdded && !wantsEvery) return;

  // querySelectorAll returns a STATIC NodeList, so it is safe to iterate
  // directly even though the callbacks below can mutate the DOM.
  const matches = roots.scanRoot.querySelectorAll<Element>(resolved.get(handler)!.selector);
  for (const el of matches) {
    let ctx = seen.get(el);

    if (!ctx) {
      // Every handler needed this check, so it stopped being the author's job.
      if (!el.getAttribute(attribute)) {
        if (!warnedEmpty.has(el)) {
          warnedEmpty.add(el);
          logger.warn(
            `${attribute} on <${el.tagName.toLowerCase()}> has an empty value; skipping. ` +
              `An attribute handler's value is its configuration — an empty one is a template bug.`
          );
        }
        continue;
      }
      warnedEmpty.delete(el);
      ctx = makeElementContext(handler, el);
      seen.set(el, ctx);
      if (wantsAdded) {
        try {
          handler.onElementAdded!(el, ctx);
        } catch (error) {
          reportHookError(handler, "onElementAdded", error);
        }
      }
    }

    if (wantsEvery) {
      try {
        handler.onElement!(el, ctx);
      } catch (error) {
        reportHookError(handler, "onElement", error);
      }
    }
  }
}

/**
 * Builds the per-element context ONCE. Every member is an accessor, which is
 * what lets a single instance stay correct for the element's whole life:
 * `value` re-reads the attribute after a server re-render, `send` follows a
 * reconnect, and `wrapperRoot` follows a cross-handler navigation. A handler
 * captures this object in a listener and keeps reading through it.
 */
function makeElementContext(handler: DeclarativeHandler, el: Element): ElementContext {
  return {
    get value(): string {
      return el.getAttribute(handler.attribute) || "";
    },
    get send(): SendFn | undefined {
      return handler.needsServerChannel ? currentSend.get(handler) : undefined;
    },
    get wrapperRoot(): Element {
      // Only reachable from inside or after a dispatch, which always sets this.
      return currentRoots.get(handler)!.wrapperRoot;
    },
  };
}

/**
 * Drops elements that detached from the document or lost the attribute via a
 * server diff, notifying the handler about each.
 *
 * Runs on every render, including ones no scan is performed for: an attribute
 * can be removed by a diff that adds nothing, and a handler that keeps firing
 * for an element the server has disarmed is the single most common bug in the
 * hardcoded handlers this registry replaced. See runHandler for why the sweep
 * and the scan are gated differently. The cost is two O(1) reads per tracked
 * element per render.
 *
 * Snapshotting the keys is deliberate: the loop calls third-party code that may
 * itself touch the DOM, and iterating a Map while a callback mutates it is not
 * a contract worth exporting.
 */
function sweep(handler: DeclarativeHandler, seen: Map<Element, ElementContext>): void {
  if (seen.size === 0) return;
  for (const el of Array.from(seen.keys())) {
    // An element counts as armed iff it is in the document AND its attribute
    // still carries a value. Emptying the value is treated exactly like
    // removing the attribute, which is the same rule the scan applies when it
    // decides whether to track an element in the first place: a handler's value
    // is its configuration, so no configuration means not armed. Without this
    // the two halves disagree — the scan refuses to arm an empty element while
    // the sweep insists an emptied one is still live — and a handler wired for
    // `{{.ShareURL}}` keeps its listeners after the URL goes away.
    if (el.isConnected && el.getAttribute(handler.attribute)) continue;
    seen.delete(el);
    notifyRemoved(handler, el);
  }
}
