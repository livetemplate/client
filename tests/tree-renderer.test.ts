/**
 * TreeRenderer Tests - Range to Non-Range Transitions
 *
 * In LiveTemplate, tree structures represent rendered template content:
 *
 * "Range" structure: Represents a {{range .Items}}...{{end}} loop
 *   - Has `d` (dynamics): Array of rendered items
 *   - Has `s` (statics): Array of static HTML between dynamic slots
 *   - Example: { d: [{0: "Item 1"}, {0: "Item 2"}], s: ["<li>", "</li>"] }
 *
 * "Non-range" structure: Any other content (e.g., {{else}} clause)
 *   - Has numbered keys for dynamic content
 *   - Has `s` for statics, but NO `d` array
 *   - Example: { s: ["<p>No items</p>"], 0: "search query" }
 *
 * The bug these tests cover: When transitioning from range to non-range,
 * the old merge behavior preserved the `d` array, causing old items to
 * render with new statics (e.g., "No posts found matching [old post title]").
 */
import { TreeRenderer } from "../state/tree-renderer";
import { createLogger } from "../utils/logger";

describe("TreeRenderer", () => {
  let renderer: TreeRenderer;
  let mockConsole: {
    error: jest.Mock;
    warn: jest.Mock;
    info: jest.Mock;
    debug: jest.Mock;
    log: jest.Mock;
  };

  beforeEach(() => {
    mockConsole = {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      log: jest.fn(),
    };
    const logger = createLogger({
      level: "debug",
      sink: mockConsole as unknown as Console,
    });
    renderer = new TreeRenderer(logger);
  });

  describe("applyUpdate - range to non-range transition", () => {
    it("should replace range structure with else clause content", () => {
      // Initial state: range with items (posts exist)
      const initialUpdate = {
        s: ["<div>", "</div>"],
        0: {
          d: [
            { 0: "Post Title 1", _k: "id-1" },
            { 0: "Post Title 2", _k: "id-2" },
          ],
          s: ["<p>", "</p>"],
        },
      };
      renderer.applyUpdate(initialUpdate);

      // Verify initial state has range items
      const stateAfterInitial = renderer.getTreeState();
      expect(stateAfterInitial[0]).toHaveProperty("d");
      expect(stateAfterInitial[0].d).toHaveLength(2);

      // Update: else clause (no posts, search returned empty)
      // This is what the server sends when range becomes empty
      const elseUpdate = {
        0: {
          s: ['<p>No posts found matching "', '"</p>'],
          0: "search query",
        },
      };
      renderer.applyUpdate(elseUpdate);

      // Verify: old range 'd' should be REPLACED, not preserved
      const stateAfterElse = renderer.getTreeState();

      // The key assertion: 'd' should NOT exist after range→non-range transition
      expect(stateAfterElse[0]).not.toHaveProperty("d");

      // Should have the else clause content
      expect(stateAfterElse[0]).toHaveProperty("0", "search query");
      expect(stateAfterElse[0].s).toEqual([
        '<p>No posts found matching "',
        '"</p>',
      ]);
    });

    it("should preserve range structure when update also has range", () => {
      // Initial state: range with items
      const initialUpdate = {
        s: ["<div>", "</div>"],
        0: {
          d: [{ 0: "Item 1", _k: "id-1" }],
          s: ["<li>", "</li>"],
        },
      };
      renderer.applyUpdate(initialUpdate);

      // Update: still a range but with different items
      const rangeUpdate = {
        0: {
          d: [
            { 0: "Item 1", _k: "id-1" },
            { 0: "Item 2", _k: "id-2" },
          ],
          s: ["<li>", "</li>"],
        },
      };
      renderer.applyUpdate(rangeUpdate);

      // Should merge/update the range, not replace entirely
      const state = renderer.getTreeState();
      expect(state[0]).toHaveProperty("d");
      expect(state[0].d).toHaveLength(2);
    });

    it("should handle nested range to non-range transitions", () => {
      // Initial: nested structure with range
      const initialUpdate = {
        s: ["<main>", "</main>"],
        0: {
          s: ["<section>", "</section>"],
          0: {
            d: [{ 0: "Nested Item", _k: "nested-1" }],
            s: ["<span>", "</span>"],
          },
        },
      };
      renderer.applyUpdate(initialUpdate);

      // Update nested path with non-range content
      const nestedElseUpdate = {
        0: {
          0: {
            s: ["<p>", "</p>"],
            0: "No nested items",
          },
        },
      };
      renderer.applyUpdate(nestedElseUpdate);

      // Nested range should be replaced
      const state = renderer.getTreeState();
      expect(state[0][0]).not.toHaveProperty("d");
      expect(state[0][0][0]).toBe("No nested items");
    });
  });

  describe("render - range to non-range transition", () => {
    it("should render else content after range items are removed", () => {
      // Initial: range with items
      const initialUpdate = {
        s: ["<ul>", "</ul>"],
        0: {
          d: [
            { 0: "Apple", _k: "1" },
            { 0: "Banana", _k: "2" },
          ],
          s: ["<li>", "</li>"],
        },
      };
      const initialResult = renderer.applyUpdate(initialUpdate);

      expect(initialResult.html).toContain("<li>Apple</li>");
      expect(initialResult.html).toContain("<li>Banana</li>");

      // Update to else clause
      const elseUpdate = {
        0: {
          s: ["<p>", "</p>"],
          0: "No items available",
        },
      };
      const elseResult = renderer.applyUpdate(elseUpdate);

      // Should NOT contain old items
      expect(elseResult.html).not.toContain("Apple");
      expect(elseResult.html).not.toContain("Banana");
      // Should contain else content
      expect(elseResult.html).toContain("<p>No items available</p>");
    });
  });
});
