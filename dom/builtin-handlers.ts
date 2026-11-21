/**
 * The built-in `lvt-*` attribute handlers, expressed as registry entries.
 *
 * Every handler here goes through the SAME public interface an external author
 * uses — that is the point of the file. There is no privileged internal path:
 * if a built-in needs something `AttributeHandler` can't express, that is a gap
 * in the public API, not a reason for a side door.
 *
 * All of them use the LOW-LEVEL layer (`selectors` + `setup`/`teardown`), not
 * the declarative one. They predate the registry, their bodies are unchanged by
 * the migration, and `tests/directives.test.ts` calls those bodies directly —
 * so keeping the functions intact is what makes the existing suite a regression
 * net for this refactor rather than a casualty of it. New handlers should
 * prefer the declarative layer.
 *
 * `selectors` is descriptive here: the loop dispatches by calling `setup()`,
 * never by reading the array. It documents what the handler claims, for a human
 * and for the duplicate-registration warning. Two entries below legitimately
 * walk every descendant and say so.
 *
 * REGISTRATION ORDER IS BEHAVIOUR. These register in exactly the order the
 * hardcoded post-render sequence called them, because a handler that flashes a
 * highlight and one that scrolls the same element are not commutative.
 */

import { registerAttribute, type AttributeHandler } from "../attribute-registry";
import {
  handleAnimateDirectives,
  handleHighlightDirectives,
  handleScrollDirectives,
  handleShadowRootHydration,
  handleToastDirectives,
  setupFxDOMEventTriggers,
  teardownFxDOMEventTriggers,
} from "./directives";
import { setupScrollAway, teardownScrollAway } from "./scroll-away";

/**
 * Every built-in, in the order the hardcoded post-render sequence called them.
 *
 * The order is PRESERVED rather than asserted to matter: this migration's bar
 * is that nothing changes behaviour, and reordering would be a change made
 * without evidence. No non-commuting pair is currently known.
 *
 * prereview's handlers ran in the middle of this list until they moved to
 * prereview's own bundle (#473 Phase 4), which registers after core. If order
 * turns out to matter for a pair, it has to become something the interface
 * expresses: a coarse stable-sorted phase, never integer priorities, which in
 * a public registry become a z-index war.
 */
const builtinHandlers: AttributeHandler[] = [
  // Core: referenced by code the framework ships, or by 2+ apps.
  {
    name: "lvt-fx:scroll",
    selectors: ["[lvt-fx\\:scroll]"],
    setup: ({ scanRoot }) => handleScrollDirectives(scanRoot),
  },
  {
    name: "lvt-fx:highlight",
    selectors: ["[lvt-fx\\:highlight]"],
    setup: ({ scanRoot }) => handleHighlightDirectives(scanRoot),
  },
  {
    name: "lvt-fx:animate",
    selectors: ["[lvt-fx\\:animate]"],
    setup: ({ scanRoot }) => handleAnimateDirectives(scanRoot),
  },
  {
    // Claims [data-toast-trigger] and the toast stack, not an lvt-* name: the
    // framework emits the markers itself from lvt/components/toast.
    name: "lvt-toast-stack",
    claims: [],
    selectors: ["[data-toast-trigger]", "[data-lvt-toast-stack]"],
    setup: ({ scanRoot }) => handleToastDirectives(scanRoot),
  },

  {
    // A platform bridge, not an app feature: it activates Declarative Shadow
    // DOM that morphdom inserted via DOM APIs, which don't auto-hydrate.
    name: "shadow-root-hydration",
    claims: [],
    selectors: ["template[shadowrootmode]"],
    setup: ({ scanRoot }) => handleShadowRootHydration(scanRoot),
  },
  {
    name: "lvt-scroll-away",
    selectors: ["[lvt-scroll-away]"],
    setup: ({ scanRoot }) => setupScrollAway(scanRoot),
    teardown: (root) => teardownScrollAway(root),
  },
  {
    // Walks every descendant to attach direct listeners for
    // lvt-fx:<effect>:on:<domevent>, so it earns the wire-idempotent skip:
    // at 80k descendants the walk costs ~150-200ms and re-running on an
    // unchanged DOM finds nothing new.
    name: "lvt-fx:*:on:*",
    // The census reports `lvt-fx:highlight:on:click` as `lvt-fx:highlight`,
    // which the effect's own handler claims; this walker claims nothing more.
    claims: [],
    selectors: ["*"],
    category: "wire-idempotent",
    setup: ({ scanRoot, wrapperRoot }) => setupFxDOMEventTriggers(scanRoot, wrapperRoot),
    teardown: (root) => teardownFxDOMEventTriggers(root),
  },
];

let registered = false;

/**
 * Registers every built-in. Called once at module load, before any user code
 * can run, so built-ins always occupy the earliest registry slots and a
 * third-party handler claiming the same name is the one that gets warned about.
 *
 * Guarded, because the registry is module-level state and this is now a named
 * entry point rather than inline top-of-file code. A page that evaluates the
 * bundle twice — a duplicated <script>, a bundler that fails to dedupe — would
 * otherwise register every handler a second time, and each would run twice per
 * render. The duplicate-name warning would fire on the way there, so it would
 * not be silent, but doubled work is not something to leave to a console
 * warning.
 */
export function registerBuiltinHandlers(): void {
  if (registered) return;
  registered = true;
  for (const handler of builtinHandlers) registerAttribute(handler);
}

/** Test-only: lets a suite re-register after clearing the registry. */
export function __resetBuiltinRegistrationForTesting(): void {
  registered = false;
}
