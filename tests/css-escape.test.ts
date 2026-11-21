import { cssEscape } from "../utils/css-escape";

// Keys and ids that hold CSS special characters must still select their
// element, with the native CSS.escape and with the fallback.
describe("cssEscape", () => {
  const values = [
    `TestParseValue/"hello"`,
    `TestParseValue/'world'`,
    "a:b.c#d[e]",
    "with space",
    "back\\slash",
    "1starts-with-digit",
    "-2dash-digit",
    "plain-key_1",
  ];

  function selects(escape: (v: string) => string) {
    for (const v of values) {
      document.body.innerHTML = "";
      const el = document.createElement("div");
      el.setAttribute("data-key", v);
      el.id = v;
      document.body.appendChild(el);
      expect(document.querySelector(`[data-key="${escape(v)}"]`)).toBe(el);
      expect(document.querySelector(`#${escape(v)}`)).toBe(el);
    }
  }

  it("uses the native CSS.escape when present", () => {
    const saved = (globalThis as any).CSS;
    const escape = jest.fn((v: string) => "native:" + v);
    (globalThis as any).CSS = { escape };
    try {
      expect(cssEscape("a\"b")).toBe('native:a"b');
      expect(escape).toHaveBeenCalledWith('a"b');
    } finally {
      (globalThis as any).CSS = saved;
    }
  });

  it("selects with the fallback when CSS.escape is missing", () => {
    const saved = (globalThis as any).CSS;
    (globalThis as any).CSS = undefined;
    try {
      selects(cssEscape);
    } finally {
      (globalThis as any).CSS = saved;
    }
  });
});
