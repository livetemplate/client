/** Escapes colons in attribute names for use in CSS attribute selectors. */
export function lvtSelector(attr: string, value?: string): string {
  const escaped = attr.replace(/:/g, "\\:");
  return value !== undefined ? `[${escaped}="${value}"]` : `[${escaped}]`;
}
