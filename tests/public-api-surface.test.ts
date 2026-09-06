/**
 * @jest-environment node
 */

/**
 * The browser bundle's public surface.
 *
 * WHY THIS BUILDS ITS OWN BUNDLE instead of reading `dist/`: an earlier version
 * did the latter and had three behaviours depending on ambient state — skipped
 * when `dist/` was absent (which is CI, so it never ran there), failing when
 * `dist/` was stale (which is any checkout that hasn't rebuilt), and passing
 * only in a tree that had just built. `npm test` runs before `npm run build` in
 * both CI and scripts/release.sh, so the "passing" case was the rare one.
 *
 * A test whose most common outcome is a silent skip is not pinning anything.
 * Building in-process makes the assertion deterministic and always real.
 *
 * Runs under the `node` environment because esbuild refuses to run in jsdom
 * (jsdom's Buffer is from another realm, so esbuild's
 * `Buffer.from("") instanceof Uint8Array` invariant is false). That works out:
 * evaluating the bundle here also proves it can be loaded in a non-browser
 * context at all — `autoInit()` self-guards on `typeof window`, and built-in
 * registration is DOM-free by design.
 *
 * The finding it exists to pin is a property of the BUILD, not the source:
 * esbuild's `--global-name=LiveTemplateClient` over a module that ALSO exports a
 * class of that name makes `window.LiveTemplateClient` the module NAMESPACE
 * object, so `LiveTemplateClient.registerAttribute(...)` — the spelling every
 * doc example uses — resolves to the module-level named export, and the class
 * sits at `LiveTemplateClient.LiveTemplateClient`. Source-level tests cannot
 * tell those two apart.
 */

import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.join(__dirname, "..");
const ENTRY = path.join(ROOT, "livetemplate-client.ts");

/** The flags this test mirrors from package.json's `build:browser`. */
const REQUIRED_BUILD_FLAGS = ["--bundle", "--format=iife", "--global-name=LiveTemplateClient"];

describe("browser bundle public surface", () => {
  let bundle: string;

  beforeAll(() => {
    const result = esbuild.buildSync({
      entryPoints: [ENTRY],
      bundle: true,
      format: "iife",
      globalName: "LiveTemplateClient",
      target: "es2018",
      write: false,
      // Deliberately not minified: it does not affect the global shape and
      // keeps this build fast.
    });
    bundle = result.outputFiles[0].text;
  });

  it("mirrors the flags package.json actually builds with", () => {
    // Guards the premise of this whole file. If build:browser stops passing
    // --global-name, or changes format, the bundle built above stops
    // representing the shipped one and these assertions quietly mean nothing.
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const script: string = pkg.scripts["build:browser"];
    for (const flag of REQUIRED_BUILD_FLAGS) {
      expect(script).toContain(flag);
    }
  });

  it("exposes registerAttribute on the IIFE global", () => {
    // The bundle opens with "use strict", and a strict-mode eval keeps its
    // `var` bindings local — unlike a real <script>, where a top-level `var`
    // becomes a global. So the assignment is appended rather than relying on
    // a leak the browser would give us.
    // eslint-disable-next-line no-eval
    (0, eval)(bundle + "\n;globalThis.__lvtBundleGlobal = LiveTemplateClient;");

    const ns = (globalThis as any).__lvtBundleGlobal;
    expect(typeof ns.registerAttribute).toBe("function");
    // The class is a member of the namespace, not the namespace itself.
    expect(typeof ns.LiveTemplateClient).toBe("function");
    expect(typeof ns.LiveTemplateClient.registerAttribute).toBe("function");
  });

  it("re-exports the handler types from the package entry", () => {
    // Source-level on purpose: whether these land in dist/*.d.ts is decided by
    // `declaration: true` (always on in tsconfig) plus this re-export. Checking
    // the re-export needs no build, so unlike the old dist/ probe it cannot
    // silently skip.
    const entry = fs.readFileSync(ENTRY, "utf8");
    for (const symbol of [
      "AttributeHandler",
      "DeclarativeHandler",
      "LowLevelHandler",
      "ElementContext",
      "SetupContext",
      "SendFn",
      "HandlerCategory",
    ]) {
      expect(entry).toContain(symbol);
    }
    expect(entry).toContain('export { registerAttribute } from "./attribute-registry"');
  });
});
