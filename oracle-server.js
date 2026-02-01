#!/usr/bin/env node
/**
 * Persistent Oracle Server for Go fuzz testing framework.
 *
 * Unlike cross-validate.ts which handles a single request and exits,
 * this server stays alive and handles multiple requests via line-delimited JSON.
 *
 * Protocol:
 * - Each line of stdin is a JSON request: {"oldTree": ..., "diff": ...}
 * - Each request gets a JSON response on stdout: {"html": ..., "tree": ..., "error": ...}
 * - Server exits when stdin closes
 *
 * This reduces per-request overhead from ~300ms (process spawn) to ~20-50ms (IPC only).
 */

const readline = require("readline");
const { TreeRenderer } = require("./dist/state/tree-renderer");
const { createLogger } = require("./dist/utils/logger");

// Create a silent logger to avoid console output
const logger = createLogger({ level: "error" });

// Create readline interface for line-by-line processing
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

// Process each line as a separate request
rl.on("line", (line) => {
  try {
    const data = JSON.parse(line);

    // Create a fresh renderer for each request to avoid state leakage
    const renderer = new TreeRenderer(logger);

    // Apply the old tree first (initial state)
    if (data.oldTree) {
      renderer.applyUpdate(data.oldTree);
    }

    // Apply the diff
    const result = renderer.applyUpdate(data.diff);

    // Get the current tree state from renderer
    const finalTree = renderer.getTreeState();

    const output = {
      html: result.html,
      tree: finalTree,
      error: null,
    };

    // Write response as single line
    console.log(JSON.stringify(output));
  } catch (err) {
    const output = {
      html: "",
      tree: null,
      error: err instanceof Error ? err.message : String(err),
    };
    console.log(JSON.stringify(output));
  }
});

// Handle stdin close
rl.on("close", () => {
  process.exit(0);
});

// Handle errors gracefully - use stdout to maintain JSON protocol
// Exit after uncaught exception as process state may be corrupted
process.on("uncaughtException", (err) => {
  console.log(JSON.stringify({ html: "", tree: null, error: err.message }));
  process.exit(1);
});
