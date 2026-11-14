/**
 * The attribute census: warn about `lvt-*` attributes nothing handles.
 *
 * The server advertises every `lvt-*` attribute name its template uses
 * (`meta.attributes`, initial render only). An attribute with no handler is
 * inert HTML — it does nothing, silently — so the client compares that list
 * against what is claimed and warns once per unclaimed name. The common cause is
 * a handler bundle that did not load, or a typo.
 *
 * WHO CLAIMS WHAT. Registry handlers claim their own names (a declarative
 * handler's `attribute`, a low-level handler's `claims`), so a handler that
 * moves to another bundle takes its claim with it and its absence becomes
 * visible. The mechanisms below are outside the registry — event delegation,
 * morphdom hooks, the change auto-wirer, observers — and never relocate, so
 * they claim through this one static list.
 *
 * CASE. The server reports the AUTHORED spelling (`lvt-el:addClass`) so the
 * warning is greppable in the template; HTML parsers lowercase attribute names
 * before any handler sees them. Both sides are folded before comparing.
 */

import { registeredClaims, type AttributeHandler } from "./attribute-registry";
import { createLogger } from "./utils/logger";

const logger = createLogger({ scope: "AttributeCensus" });

/** Claims of the core mechanisms that are not registry handlers. */
export const CORE_CLAIMS: readonly string[] = [
  // Event delegation: action routing, modifiers, forms, navigation.
  "lvt-on:",
  "lvt-mod:",
  "lvt-form:",
  "lvt-nav:",
  "lvt-key",
  "lvt-persist",
  "lvt-no-intercept",
  "lvt-autofocus",
  "lvt-focus-trap",
  // Reactive attributes and their DOM-event triggers.
  "lvt-el:",
  // Morphdom hooks.
  "lvt-ignore",
  "lvt-ignore-attrs",
  // Change auto-wirer. It also still skips lvt-change and lvt-input, but those
  // were removed in v0.8.13 for lvt-on:: a leftover never sends its action, so
  // they stay unclaimed and warn.
  "lvt-debounce",
  // Lifecycle hooks, run by the DOM patcher.
  "lvt-mounted",
  "lvt-updated",
  "lvt-destroyed",
  // Infinite-scroll observer.
  "lvt-scroll-sentinel",
];

/** Whether a lowercased census name is covered by one of the lowercased claims. */
export function isClaimed(name: string, claims: readonly string[]): boolean {
  for (const claim of claims) {
    if (claim.endsWith(":") ? name.startsWith(claim) : name === claim) return true;
  }
  return false;
}

// Module-level on purpose: the warning is once per page, so a second client
// instance or a reconnect does not repeat it.
const warned = new Set<string>();

/**
 * Warns once per page for every census name nothing claims.
 *
 * Runs after the window `load` event, not when the census arrives: a handler
 * bundle loaded with `async`, or injected, can still be fetching when the
 * initial frame lands, and `load` waits for every script in the document.
 * Claims are read at that moment, so anything registered by then counts.
 */
export function reportUnclaimedAttributes(
  names: readonly string[],
  instanceHandlers: readonly AttributeHandler[]
): void {
  if (typeof window === "undefined" || names.length === 0) return;
  const check = () => {
    const claims = [...CORE_CLAIMS, ...registeredClaims(), ...registeredClaims(instanceHandlers)];
    for (const authored of names) {
      if (typeof authored !== "string") continue;
      const name = authored.toLowerCase();
      if (warned.has(name) || isClaimed(name, claims)) continue;
      warned.add(name);
      logger.warn(
        `${authored} is used by this page's template, but no attribute handler claims it, ` +
          `so it does nothing. Is the script that registers it loaded, or is the name misspelled? ` +
          `(A low-level handler claims names through \`claims\`.)`
      );
    }
  };
  if (document.readyState === "complete") check();
  else window.addEventListener("load", check, { once: true });
}

/** Test-only: forget which names were already warned about. */
export function __resetCensusForTesting(): void {
  warned.clear();
}
