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
 * net for this refactor rather than a casualty of it. New handlers, and the
 * ones that move to their owning app in Phase 4, should prefer the declarative
 * layer.
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
  handleAreaSelectDirectives,
  handleAutoClickDirectives,
  handleHighlightDirectives,
  handleIframeAutoHeightDirectives,
  handlePreviewBridgeDirectives,
  handleProxyBridgeDirectives,
  handleRegionSelectDirectives,
  handleScrollDirectives,
  handleShadowRootHydration,
  handleTextSelectDirectives,
  handleToastDirectives,
  handleURLHashDirective,
  handleViewportReportDirectives,
  setupFxDOMEventTriggers,
  teardownAreaSelectForRoot,
  teardownAutoClickTimers,
  teardownFxDOMEventTriggers,
  teardownIframeAutoHeightForRoot,
  teardownPreviewBridgeForRoot,
  teardownProxyBridgeForRoot,
  teardownRegionSelectForRoot,
  teardownTextSelectForRoot,
  teardownURLHashForRoot,
  teardownViewportReportForRoot,
} from "./directives";
import { handleResizeDirectives, teardownResizeForRoot } from "./resize";
import { setupScrollAway, teardownScrollAway } from "./scroll-away";
import { setupSpy, teardownSpy } from "./spy";

/**
 * Every built-in, in the order the hardcoded post-render sequence called them.
 *
 * The order is PRESERVED rather than asserted to matter: this migration's bar
 * is that nothing changes behaviour, and reordering would be a change made
 * without evidence. No non-commuting pair is currently known.
 *
 * Phase 4 will test that: the handlers marked below as relocating move to a
 * bundle that necessarily evaluates AFTER core, so they will register last
 * rather than in the middle. If that turns out to matter for any pair, order
 * has to become something the interface expresses — a coarse stable-sorted
 * phase, never integer priorities, which in a public registry become a z-index
 * war. If it does not matter, this note can go.
 */
const builtinHandlers: AttributeHandler[] = [
  // ---- core: referenced by code the framework ships, or by 2+ apps ----
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
    selectors: ["[data-toast-trigger]", "[data-lvt-toast-stack]"],
    setup: ({ scanRoot }) => handleToastDirectives(scanRoot),
  },

  // ---- relocating to prereview in Phase 4 ----
  //
  // Their only consumer is prereview. They register through the public
  // interface from this repo today so that Phase 4 is a file move rather than a
  // rewrite. Six of them are the `needsServerChannel` path's real consumers —
  // no core handler exercises that flag, so without these it would ship
  // untried.
  {
    name: "lvt-fx:auto-click",
    selectors: ["[lvt-fx\\:auto-click]"],
    setup: ({ scanRoot }) => handleAutoClickDirectives(scanRoot),
    // dispose(), not teardown(root): the timers this arms are module-global,
    // so there is no root to scope their cleanup to. dispose() runs on every
    // disconnect, including one with no wrapper element — which is what the
    // hardcoded teardownAutoClickTimers() call used to guarantee.
    dispose: () => teardownAutoClickTimers(),
  },
  {
    name: "lvt-fx:area-select",
    selectors: ["[lvt-fx\\:area-select]"],
    needsServerChannel: true,
    setup: ({ scanRoot, send }) => handleAreaSelectDirectives(scanRoot, send!),
    teardown: (root) => teardownAreaSelectForRoot(root),
  },
  {
    name: "lvt-fx:resize",
    selectors: ["[lvt-fx\\:resize]"],
    setup: ({ scanRoot }) => handleResizeDirectives(scanRoot),
    teardown: (root) => teardownResizeForRoot(root),
  },
  {
    name: "lvt-fx:region-select",
    selectors: ["[lvt-fx\\:region-select]"],
    needsServerChannel: true,
    setup: ({ scanRoot, send }) => handleRegionSelectDirectives(scanRoot, send!),
    teardown: (root) => teardownRegionSelectForRoot(root),
  },
  {
    name: "lvt-fx:text-select",
    selectors: ["[lvt-fx\\:text-select]"],
    needsServerChannel: true,
    setup: ({ scanRoot, send }) => handleTextSelectDirectives(scanRoot, send!),
    teardown: (root) => teardownTextSelectForRoot(root),
  },
  {
    name: "lvt-fx:viewport-report",
    selectors: ["[lvt-fx\\:viewport-report]"],
    needsServerChannel: true,
    setup: ({ scanRoot, send }) => handleViewportReportDirectives(scanRoot, send!),
    teardown: (root) => teardownViewportReportForRoot(root),
  },
  {
    name: "lvt-fx:proxy-bridge",
    selectors: ["[lvt-fx\\:proxy-bridge]"],
    needsServerChannel: true,
    setup: ({ scanRoot, send }) => handleProxyBridgeDirectives(scanRoot, send!),
    teardown: (root) => teardownProxyBridgeForRoot(root),
  },
  {
    name: "lvt-fx:iframe-autoheight",
    selectors: ["iframe[lvt-fx\\:iframe-autoheight]"],
    setup: ({ scanRoot }) => handleIframeAutoHeightDirectives(scanRoot),
    teardown: (root) => teardownIframeAutoHeightForRoot(root),
  },
  {
    name: "lvt-fx:preview-bridge",
    selectors: ["iframe[lvt-fx\\:preview-bridge]"],
    setup: ({ scanRoot }) => handlePreviewBridgeDirectives(scanRoot),
    teardown: (root) => teardownPreviewBridgeForRoot(root),
  },
  {
    name: "lvt-fx:url-hash",
    selectors: ["[lvt-fx\\:url-hash]"],
    needsServerChannel: true,
    setup: ({ scanRoot, send }) => handleURLHashDirective(scanRoot, send!),
    teardown: (root) => teardownURLHashForRoot(root),
  },

  // ---- core, continued (these ran after the relocating group) ----
  {
    // A platform bridge, not an app feature: it activates Declarative Shadow
    // DOM that morphdom inserted via DOM APIs, which don't auto-hydrate.
    name: "shadow-root-hydration",
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
    name: "lvt-spy",
    selectors: ["[lvt-spy]"],
    setup: ({ scanRoot }) => setupSpy(scanRoot),
    teardown: (root) => teardownSpy(root),
  },
  {
    // Walks every descendant to attach direct listeners for
    // lvt-fx:<effect>:on:<domevent>, so it earns the wire-idempotent skip:
    // at 80k descendants the walk costs ~150-200ms and re-running on an
    // unchanged DOM finds nothing new.
    name: "lvt-fx:*:on:*",
    selectors: ["*"],
    category: "wire-idempotent",
    setup: ({ scanRoot, wrapperRoot }) => setupFxDOMEventTriggers(scanRoot, wrapperRoot),
    teardown: (root) => teardownFxDOMEventTriggers(root),
  },
];

/**
 * Registers every built-in. Called once at module load, before any user code
 * can run, so built-ins always occupy the earliest registry slots and a
 * third-party handler claiming the same name is the one that gets warned about.
 */
export function registerBuiltinHandlers(): void {
  for (const handler of builtinHandlers) {
    registerAttribute(handler);
  }
}
