/**
 * @jest-environment node
 */

/**
 * The registry in a non-browser context (SSR, build tooling, a test harness
 * that imports the package for its types or testing utilities).
 *
 * Deliberately a separate file with a `node` environment rather than a case in
 * the jsdom suite: jsdom defines `document` as NON-CONFIGURABLE, so
 * `delete globalThis.document` silently no-ops and a test written that way
 * passes without ever simulating the thing it claims to. This environment has
 * genuinely never had a `document`.
 *
 * What must hold here: importing the module and registering handlers does not
 * throw. Nothing renders in this context, so the DOM-dependent half of
 * registration is skipped rather than failed.
 */

import {
  getRegisteredAttributes,
  registerAttribute,
  __resetRegistryForTesting,
} from "../attribute-registry";
import {
  registerBuiltinHandlers,
  __resetBuiltinRegistrationForTesting,
} from "../dom/builtin-handlers";

beforeEach(() => {
  __resetRegistryForTesting();
  __resetBuiltinRegistrationForTesting();
});

it("has no document, which is the point of this file", () => {
  expect(typeof document).toBe("undefined");
});

it("registers the built-ins at module load without a DOM", () => {
  // registerBuiltinHandlers() runs unconditionally at module load, so this is
  // what an SSR import already does today.
  expect(() => registerBuiltinHandlers()).not.toThrow();
  expect(getRegisteredAttributes().length).toBeGreaterThan(0);
});

it("registers a declarative handler without a DOM", () => {
  // The selector-validity probe is the only DOM access on the registration
  // path. It has to degrade rather than throw.
  expect(() =>
    registerAttribute({ attribute: "lvt-x:copy", onElementAdded: () => {} })
  ).not.toThrow();
  expect(getRegisteredAttributes()).toHaveLength(1);
});

it("still applies the shape checks that need no DOM", () => {
  // Skipping the selector probe must not turn registration into a free-for-all:
  // everything that can be validated without a document still is.
  registerAttribute({ attribute: "lvt-x:copy", onElementRemoved: () => {} } as any);
  expect(getRegisteredAttributes()).toHaveLength(0);
});
