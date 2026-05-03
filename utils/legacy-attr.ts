import type { Logger } from "./logger";

/**
 * Module-level warn-once latch shared by all `lvt-no-intercept` shim sites
 * (link interceptor + form auto-wiring + form submit handling). One warning
 * per process is enough to prompt migration without spamming the console.
 */
let legacyNoInterceptWarned = false;

/**
 * Returns true when an element opts out of LiveTemplate interception.
 *
 * Recognizes both the current Tier 2 namespaced attribute (`newName`, e.g.
 * `lvt-nav:no-intercept` for links or `lvt-form:no-intercept` for forms) and
 * the pre-Phase 1A `lvt-no-intercept` name as a backward-compat shim. The
 * legacy name emits a one-time deprecation warning through the supplied
 * logger and is removed in v0.9.0.
 */
export function hasNoInterceptOptOut(
  el: Element,
  newName: string,
  logger: Logger
): boolean {
  if (el.hasAttribute(newName)) return true;
  if (el.hasAttribute("lvt-no-intercept")) {
    if (!legacyNoInterceptWarned) {
      legacyNoInterceptWarned = true;
      logger.warn(
        `lvt-no-intercept is deprecated; use ${newName}. The shim will be removed in v0.9.0.`
      );
    }
    return true;
  }
  return false;
}

/**
 * Reset the warn-once latch. Internal — test code only. Tests that exercise
 * the shim need to start from a clean state to assert that the warning fires
 * exactly once per process.
 *
 * @internal
 */
export function _resetLegacyNoInterceptWarned(): void {
  legacyNoInterceptWarned = false;
}
