/**
 * Escapes a string for use in a CSS selector, as an identifier (#id) or
 * inside a quoted attribute value ([data-key="..."]).
 *
 * Uses the native CSS.escape when present. The fallback escapes every
 * character outside [A-Za-z0-9_-] (and below U+00A0) as a hex escape, which
 * is valid in both positions, so a key or id holding quotes, brackets, colons
 * or spaces still selects its element.
 */
export function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (/[A-Za-z0-9_-]/.test(ch) || code >= 0xa0) {
      out += ch;
    } else {
      out += "\\" + code.toString(16) + " ";
    }
  }
  // An identifier may not start with a digit, or with "-" then a digit.
  return out.replace(/^(-?)([0-9])/, (_, dash, digit) => dash + "\\3" + digit + " ");
}
