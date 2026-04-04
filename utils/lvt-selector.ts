/** Escapes colons in attribute names for use in CSS attribute selectors. */
export function lvtSelector(attr: string, value?: string): string {
  const escaped = attr.replace(/:/g, "\\:");
  if (value === undefined) return `[${escaped}]`;
  // Escape backslashes and double-quotes in the value to prevent CSS selector injection
  const safeValue = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `[${escaped}="${safeValue}"]`;
}
