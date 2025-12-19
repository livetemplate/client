/**
 * Check if an element has lvt-confirm attribute and prompt user if needed.
 * Returns true if action should proceed, false if cancelled.
 */
export function checkLvtConfirm(element: HTMLElement): boolean {
  if (element.hasAttribute("lvt-confirm")) {
    const confirmMessage = element.getAttribute("lvt-confirm");
    if (confirmMessage && !confirm(confirmMessage)) {
      return false; // User cancelled
    }
  }
  return true; // Proceed
}

/**
 * Extract lvt-data-* attributes from an element.
 * lvt-data-id="123" becomes { id: "123" }
 * lvt-data-user-name="john" becomes { "user-name": "john" }
 */
export function extractLvtData(element: HTMLElement): Record<string, string> {
  const data: Record<string, string> = {};
  const attributes = element.attributes;

  for (let i = 0; i < attributes.length; i++) {
    const attr = attributes[i];
    if (attr.name.startsWith("lvt-data-")) {
      const key = attr.name.substring(9); // Remove "lvt-data-" prefix
      data[key] = attr.value;
    }
  }

  return data;
}
