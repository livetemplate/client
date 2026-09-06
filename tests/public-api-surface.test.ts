/**
 * The built browser bundle's public surface.
 *
 * Deliberately tested against dist/, not against the source. The finding this
 * pins is a property of the BUILD: esbuild runs
 * `--global-name=LiveTemplateClient` over a module that also exports a class of
 * that name, so `window.LiveTemplateClient` is the module NAMESPACE object and
 * the class sits at `LiveTemplateClient.LiveTemplateClient`. Every documented
 * example writes `LiveTemplateClient.registerAttribute(...)`, which therefore
 * resolves to the module-level named export and NOT to the class static. A
 * source-level test cannot tell those two apart; this one can.
 *
 * Requires `npm run build` first — see the note in the skip below.
 */

import * as fs from "fs";
import * as path from "path";

const BUNDLE = path.join(__dirname, "..", "dist", "livetemplate-client.browser.js");

describe("built browser bundle", () => {
  const built = fs.existsSync(BUNDLE);

  // Not a silent skip: if the bundle is missing the message says how to get it,
  // rather than the suite quietly reporting green on an unbuilt artefact.
  const testIfBuilt = built ? it : it.skip;
  if (!built) {
    // eslint-disable-next-line no-console
    console.warn(`[public-api-surface] ${BUNDLE} missing — run \`npm run build\`.`);
  }

  testIfBuilt("exposes registerAttribute on the IIFE global", () => {
    const code = fs.readFileSync(BUNDLE, "utf8");
    // The bundle opens with "use strict", and a strict-mode EVAL keeps its
    // `var` bindings local — unlike a real <script>, where a top-level `var`
    // becomes a global whether the script is strict or not. So the assignment
    // is appended rather than relying on the leak a browser would give us.
    // eslint-disable-next-line no-eval
    (0, eval)(code + "\n;globalThis.LiveTemplateClient = LiveTemplateClient;");

    const globalNamespace = (globalThis as any).LiveTemplateClient;
    expect(typeof globalNamespace.registerAttribute).toBe("function");
    expect(typeof globalNamespace.LiveTemplateClient).toBe("function");
    expect(typeof globalNamespace.LiveTemplateClient.registerAttribute).toBe("function");
  });

  testIfBuilt("ships the handler types in the emitted declarations", () => {
    const dts = fs.readFileSync(
      path.join(__dirname, "..", "dist", "attribute-registry.d.ts"),
      "utf8"
    );
    for (const symbol of [
      "AttributeHandler",
      "DeclarativeHandler",
      "LowLevelHandler",
      "ElementContext",
      "SetupContext",
      "SendFn",
      "registerAttribute",
    ]) {
      expect(dts).toContain(symbol);
    }
  });
});
