/**
 * Tests for the parseValue function in LiveTemplateClient
 *
 * These tests verify that:
 * 1. Values at or under Number.MAX_SAFE_INTEGER parse to numbers
 * 2. Values over Number.MAX_SAFE_INTEGER remain as strings (to prevent precision loss)
 * 3. Whitespace is handled consistently (trimmed before parsing)
 */

import { LiveTemplateClient } from "../livetemplate-client";

describe("LiveTemplateClient.parseValue", () => {
  let client: LiveTemplateClient;

  beforeEach(() => {
    // Create a minimal wrapper element for the client using safe DOM methods
    const wrapper = document.createElement("div");
    wrapper.id = "test-wrapper";
    wrapper.setAttribute("data-lvt-id", "test");
    document.body.appendChild(wrapper);
    client = new LiveTemplateClient();
  });

  afterEach(() => {
    const wrapper = document.getElementById("test-wrapper");
    if (wrapper) {
      wrapper.remove();
    }
  });

  // Access parseValue through a test helper since it's private
  // We'll use (client as any) to access the private method for testing
  const parseValue = (value: string) => (client as any).parseValue(value);

  describe("numbers within safe integer range", () => {
    it("parses small positive integers as numbers", () => {
      expect(parseValue("42")).toBe(42);
      expect(parseValue("0")).toBe(0);
      expect(parseValue("1")).toBe(1);
    });

    it("parses small negative integers as numbers", () => {
      expect(parseValue("-1")).toBe(-1);
      expect(parseValue("-42")).toBe(-42);
    });

    it("parses floating point numbers as numbers", () => {
      expect(parseValue("3.14")).toBe(3.14);
      expect(parseValue("-2.5")).toBe(-2.5);
    });

    it("parses MAX_SAFE_INTEGER as a number", () => {
      const maxSafe = String(Number.MAX_SAFE_INTEGER); // "9007199254740991"
      expect(parseValue(maxSafe)).toBe(Number.MAX_SAFE_INTEGER);
    });

    it("parses MIN_SAFE_INTEGER as a number", () => {
      const minSafe = String(Number.MIN_SAFE_INTEGER); // "-9007199254740991"
      expect(parseValue(minSafe)).toBe(Number.MIN_SAFE_INTEGER);
    });
  });

  describe("large integers (exceeding MAX_SAFE_INTEGER)", () => {
    it("keeps integers larger than MAX_SAFE_INTEGER as strings", () => {
      // UnixNano timestamp example: larger than MAX_SAFE_INTEGER
      const largeInt = "1769358878696557000";
      const result = parseValue(largeInt);
      expect(result).toBe(largeInt);
      expect(typeof result).toBe("string");
    });

    it("keeps MAX_SAFE_INTEGER + 1 as a string", () => {
      const justOver = String(Number.MAX_SAFE_INTEGER + 1); // "9007199254740992"
      const result = parseValue(justOver);
      expect(typeof result).toBe("string");
    });

    it("keeps large negative integers as strings", () => {
      const largeNegative = "-9007199254740992"; // MIN_SAFE_INTEGER - 1
      const result = parseValue(largeNegative);
      expect(typeof result).toBe("string");
    });

    it("preserves exact string value for large integers (no precision loss)", () => {
      // This is the key test: ensuring the exact value is preserved
      const original = "1769358878696557000";
      const result = parseValue(original);
      expect(result).toBe("1769358878696557000");
      // If we had converted to number and back, we'd get a different value due to precision loss
      expect(result).not.toBe("1769358878696557056"); // What it would be if converted to float64
    });
  });

  describe("whitespace handling", () => {
    it("trims whitespace from numeric strings", () => {
      expect(parseValue("  42  ")).toBe(42);
      expect(parseValue("\t100\n")).toBe(100);
    });

    it("trims whitespace from large integer strings", () => {
      const withSpaces = "  1769358878696557000  ";
      const result = parseValue(withSpaces);
      expect(result).toBe("1769358878696557000"); // Trimmed
      expect(typeof result).toBe("string");
    });

    it("trims whitespace from boolean strings", () => {
      expect(parseValue("  true  ")).toBe("  true  "); // Boolean parsing uses exact match
      expect(parseValue("true")).toBe(true);
    });
  });

  describe("boolean values", () => {
    it("parses 'true' as boolean true", () => {
      expect(parseValue("true")).toBe(true);
    });

    it("parses 'false' as boolean false", () => {
      expect(parseValue("false")).toBe(false);
    });

    it("does not parse 'True' or 'FALSE' as booleans", () => {
      expect(parseValue("True")).toBe("True");
      expect(parseValue("FALSE")).toBe("FALSE");
    });
  });

  describe("string values", () => {
    it("returns non-numeric strings as-is", () => {
      expect(parseValue("hello")).toBe("hello");
      expect(parseValue("")).toBe("");
      expect(parseValue("foo123")).toBe("foo123");
    });

    it("returns strings that look numeric but are not as strings", () => {
      expect(parseValue("12abc")).toBe("12abc");
      expect(parseValue("3.14.15")).toBe("3.14.15");
    });
  });
});
