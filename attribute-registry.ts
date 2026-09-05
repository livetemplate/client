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
 *
 * This gates the SCAN only. A declarative handler's sweep runs on every render
 * whatever its category, because skipping cleanup is a correctness bug while
 * skipping a scan is just work avoided (see runHandler).
 *
 * There was a third member, `always`, meaning "every render even if a future
 * empty-diff optimization skips other handlers". It was cut before this
 * interface shipped: nothing consumed it, `updateDOM` has no such skip to be
 * exempt from, and so it was indistinguishable from `fire-on-change` in every
 * observable way. Adding a union member later is a minor release; removing one
 * is a major, so unused surface does not get to ship first and be justified
 * afterwards.
 */
export type HandlerCategory = "fire-on-change" | "wire-idempotent";

interface BaseHandler {
  /**
   * Defaults to `attribute` for declarative handlers; REQUIRED for low-level
   * ones, where `LowLevelHandler` narrows it to non-optional.
   *
   * Required there because it is the only thing a low-level handler can be
   * identified by: `selectors` is descriptive and the duplicate-registration
   * warning deliberately never keys on it, so a nameless low-level handler is
   * invisible to that warning — and a silent clash is the one case where it
   * matters most.
   */
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
   * Root-less cleanup, run when the LAST client disconnects, whether or not a
   * wrapper element exists.
   *
   * Scoped to the last client on purpose. The registry is module-level and
   * shared by every client on the page, so a handler's module-global state is
   * too — disposing it when one of two clients disconnects would pull it out
   * from under the other. Per-client state does not belong here; it belongs in
   * `teardown(root)`, which runs for each client as it goes.
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
  /** Required: the handler's identity for diagnostics. See BaseHandler.name. */
  name: string;

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

// MODULE-LEVEL STATE, AND WHAT EACH PIECE IS KEYED BY.
//
// Two defects in review of this file were the same mistake — state keyed by
// something other than what owns the guarantee it backs — so the keys are
// listed here together, where a mismatch is easier to see than it is at five
// separate declarations:
//
//   registry     — page-wide. The set of handlers, shared by every client, by
//                  design (see the file header).
//   liveRoots    — page-wide. Which clients are attached; only used to answer
//                  "is this the last one?" for dispose().
//   tracked      — per handler, then per element. Holds each element's
//                  ElementContext AND the transport it dispatches through,
//                  which must be per element: two clients can both have
//                  elements claimed by the same handler, and an element's
//                  transport belongs to the client whose subtree contains it.
//   resolved     — per handler. Values fixed at registration, so nothing about
//                  a client or an element can vary them.
//   warnedEmpty  — per handler, then per element. One element can carry two
//                  handlers' attributes, so "already warned about this element"
//                  is only meaningful alongside "by which handler".
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
const tracked = new WeakMap<AttributeHandler, Map<Element, ElementEntry>>();

/**
 * What one tracked element's context reads through.
 *
 * Per ELEMENT, not per handler, and that distinction is load-bearing. The
 * registry is module-level by design, so two LiveTemplateClient instances can
 * be live on one page with elements matching the same attribute. Keying the
 * transport by handler alone meant whichever client rendered most recently
 * owned the slot for every other client's elements too, and a listener wired on
 * client A's element would dispatch through client B's socket.
 *
 * An element only ever matches during a dispatch whose scanRoot contains it —
 * its own client's — so a per-element record is written by exactly one client,
 * and cross-contamination stops being possible rather than being avoided.
 *
 * The fields are refreshed on every dispatch rather than captured once, which
 * is what keeps a context correct across a reconnect: the client hands in a new
 * transport and the element's own next render adopts it.
 */
interface ElementEntry {
  ctx: ElementContext;
  send: SendFn | undefined;
  wrapperRoot: Element;
}

/**
 * Values fixed at registration, computed once instead of per render: the
 * resolved category (`shouldRun` asks 19 times a render otherwise) and, for a
 * declarative handler, its escaped attribute selector.
 */
const resolved = new WeakMap<AttributeHandler, { category: HandlerCategory; selector: string }>();

/**
 * Elements already warned about for an empty attribute value, per handler.
 *
 * Keyed by HANDLER and then element, not by element alone. One element can
 * carry two independently registered attributes — `<div lvt-x:copy=""
 * lvt-x:rate="5">` — and a set shared across handlers makes them corrupt each
 * other's bookkeeping in both directions: the populated handler's "this element
 * is fine" clears the empty handler's "already warned", so the warning re-fires
 * every render; and two empty attributes on one element report only the first,
 * silently swallowing the second template bug.
 *
 * The empty-value check runs on every render, because an element with no value
 * is deliberately never tracked so it can heal the moment a real value arrives.
 * This is what stops that check becoming one warning per render — once per
 * element per handler, cleared when it heals so a value that empties again is
 * reported again.
 */
const warnedEmpty = new WeakMap<AttributeHandler, WeakSet<Element>>();

function warnedEmptySet(handler: AttributeHandler): WeakSet<Element> {
  let set = warnedEmpty.get(handler);
  if (!set) {
    set = new WeakSet<Element>();
    warnedEmpty.set(handler, set);
  }
  return set;
}

function trackedMap(handler: AttributeHandler): Map<Element, ElementEntry> {
  let map = tracked.get(handler);
  if (!map) {
    map = new Map<Element, ElementEntry>();
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
 * THREAT MODEL. This is a public, unauthenticated entry point: any script with
 * page access can register a handler with `needsServerChannel: true` and
 * dispatch actions the server cannot distinguish from an `lvt-on:click`. That
 * is intended, and it grants nothing new — `autoInit` already assigns the live
 * client to `window.liveTemplateClient`, whose `send()` is public, so a script
 * on the page could always dispatch arbitrary actions. It could equally click a
 * real `lvt-on:` element or POST to the live endpoint with the session cookie.
 *
 * The boundary that matters is the server's, and it has not moved: actions
 * arriving this way are still just actions, subject to whatever authorization
 * the handler applies. A same-origin script is fully trusted by the browser's
 * own model, so a page that runs untrusted script is already compromised in
 * ways no client-side check could fix. Never treat a registered handler as
 * evidence of anything about the caller.
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
  // Checked at runtime as well as in the type, because this API is reachable
  // from a plain <script> where no type ever ran. Without a name a low-level
  // handler cannot be named in any diagnostic, and is invisible to the
  // duplicate-registration warning — silently, which is the one outcome this
  // registry's diagnostics exist to prevent.
  if (!declarative && !handler.name) {
    logger.warn(
      "registerAttribute: a low-level handler must supply `name` — it is what " +
        "diagnostics identify it by, and `selectors` is descriptive. Ignored."
    );
    return;
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
    //
    // Skipped when there is no DOM. Registration itself is deliberately
    // DOM-free — which is why `registerBuiltinHandlers()` can run at module
    // load with no `typeof window` guard, unlike autoInit() — and this probe
    // was the one exception. A module imported by SSR or tooling must not throw
    // on a declarative registration; the check still runs for every
    // registration that happens in a browser, which is every registration that
    // can reach a render.
    if (typeof document !== "undefined") {
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
  }

  // Duplicate claim warning. Deliberately LAST, after every rejection above:
  // it says "both will run", which is only true of a handler that is actually
  // about to be accepted. Warning earlier meant a handler that reused a name
  // AND was invalid got told both would run immediately before being rejected.
  //
  // Keyed on the declarative attribute name and the resolved handler name —
  // never on `selectors`, which is descriptive and which two built-ins
  // legitimately set to a bare "*" walk.
  //
  // Case-folded because HTML parsers ASCII-lowercase attribute names, so
  // `lvt-x:doThing` and `lvt-x:dothing` are the same attribute in the DOM even
  // though they are different strings here. The scan relies on the same fact
  // from the other side: it never normalizes case, because CSS attribute
  // selectors match attribute NAMES ASCII-case-insensitively in HTML documents.
  // Both halves therefore assume an HTML document — in an XML or standalone SVG
  // context neither assumption holds, and the two would have to agree some
  // other way.
  const key = claimKey(handler);
  if (key !== null && registry.some((existing) => claimKey(existing) === key)) {
    logger.warn(
      `registerAttribute("${handlerName(handler)}"): another handler already claims this ` +
        `name. Both will run; the earlier registration is not replaced. Third-party ` +
        `attributes should avoid the lvt-fx:/lvt-el:/lvt-form: namespaces.`
    );
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

/**
 * There is deliberately no `unregisterAttribute` in Phase 1.
 *
 * Registration is append-only and duplicates both run (see the warning in
 * registerAttribute), which is correct for the documented `<script defer>`
 * production pattern where a bundle evaluates once. It is NOT sufficient for a
 * dev server that hot-reloads a handler bundle: each reload registers again and
 * the old handler keeps firing.
 *
 * Deferred rather than overlooked, because removal is not the one-liner it
 * looks like — it has to sweep the handler's tracked elements and fire
 * `onElementRemoved` for each, or the listeners the handler wired outlive the
 * handler itself, which is the exact leak the declarative layer exists to
 * prevent. That is a public-API design question, and Phase 3 is where the
 * public API is settled.
 */

/**
 * A snapshot of the registered handlers, for inspection.
 *
 * A COPY, not the live array. `readonly` is erased at compile time, so handing
 * out the real one lets any caller push into the registry or reorder it. The
 * render, teardown and dispose paths deliberately do not use this — they call
 * the runRegisteredHandlers / teardownRegisteredHandlers /
 * disposeRegisteredHandlers helpers below, which iterate the internal array
 * directly and so allocate nothing on the hot path.
 */
export function getRegisteredAttributes(): readonly AttributeHandler[] {
  return registry.slice();
}

/**
 * Runs every registered handler for one render.
 *
 * The registry iterates itself rather than exporting its array for a caller to
 * loop over: it keeps the internal array unreachable, and it means the render
 * path costs no allocation. The array is read LIVE here, so a handler
 * registered by a bundle that loaded after core participates from its very next
 * render.
 */
export function runRegisteredHandlers(
  roots: { scanRoot: Element; wrapperRoot: Element },
  send: SendFn,
  domChanged: boolean
): void {
  runHandlers(registry, roots, send, domChanged);
}

/** Tears every registered handler down against one root. */
export function teardownRegisteredHandlers(root: Element): void {
  for (const handler of registry) {
    teardownHandler(handler, root);
  }
}

/** Runs every registered handler's root-less cleanup. */
export function disposeRegisteredHandlers(): void {
  disposeHandlers(registry);
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
 * Whether any client is still attached.
 *
 * Exists so a disconnecting client can tell whether it is the LAST one, which
 * is the condition for running `dispose()`. Module-global handler state outlives
 * any single client, so tearing it down while another client is still rendering
 * through the same handler would break that client.
 */
export function hasLiveRoots(): boolean {
  return liveRoots.size > 0;
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
  sweep(handler, seen);

  if (!shouldRun(handler, domChanged)) return;
  dispatchDeclarative(handler, roots, seen, channel);
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
  seen: Map<Element, ElementEntry>,
  channel: SendFn | undefined
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
    let entry = seen.get(el);

    if (entry) {
      // Refresh before any callback runs: a reconnect hands in a new transport,
      // and a cross-handler navigation replaces the wrapper.
      entry.send = channel;
      entry.wrapperRoot = roots.wrapperRoot;
    } else {
      // Every handler needed this check, so it stopped being the author's job.
      if (!el.getAttribute(attribute)) {
        const warned = warnedEmptySet(handler);
        if (!warned.has(el)) {
          warned.add(el);
          logger.warn(
            `${attribute} on <${el.tagName.toLowerCase()}> has an empty value; skipping. ` +
              `An attribute handler's value is its configuration — an empty one is a template bug.`
          );
        }
        continue;
      }
      warnedEmpty.get(handler)?.delete(el);
      entry = { ctx: null as unknown as ElementContext, send: channel, wrapperRoot: roots.wrapperRoot };
      entry.ctx = makeElementContext(handler, el, entry);
      seen.set(el, entry);
      if (wantsAdded) {
        try {
          handler.onElementAdded!(el, entry.ctx);
        } catch (error) {
          reportHookError(handler, "onElementAdded", error);
        }
      }
    }

    if (wantsEvery) {
      try {
        handler.onElement!(el, entry.ctx);
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
function makeElementContext(
  handler: DeclarativeHandler,
  el: Element,
  entry: ElementEntry
): ElementContext {
  return {
    get value(): string {
      return el.getAttribute(handler.attribute) || "";
    },
    get send(): SendFn | undefined {
      return entry.send;
    },
    get wrapperRoot(): Element {
      return entry.wrapperRoot;
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
function sweep(handler: DeclarativeHandler, seen: Map<Element, ElementEntry>): void {
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
