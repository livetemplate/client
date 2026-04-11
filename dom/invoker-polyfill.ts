/**
 * Polyfill for the HTML Invoker Commands API (command/commandfor).
 * Enables <button command="show-modal" commandfor="dialog-id"> to work
 * cross-browser by calling .showModal()/.close() on the target <dialog>.
 *
 * No-op when native support is detected.
 * Spec: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/command
 */

let installed = false;

function handleClick(e: Event): void {
  const button = (e.target as Element).closest(
    "button[commandfor]"
  ) as HTMLButtonElement | null;
  if (!button) return;

  const targetId = button.getAttribute("commandfor");
  if (!targetId) return;

  const command = button.getAttribute("command");
  const target = document.getElementById(targetId);
  if (!target || !(target instanceof HTMLDialogElement)) return;

  if (command === "show-modal" && !target.open) {
    target.showModal();
  } else if (command === "close" && target.open) {
    target.close();
  }
}

export function setupInvokerPolyfill(): void {
  if ("commandForElement" in HTMLButtonElement.prototype) return;
  if (installed) return;

  installed = true;
  document.addEventListener("click", handleClick);
}

/** Reset polyfill state. Exported for testing only. */
export function teardownInvokerPolyfill(): void {
  if (installed) {
    document.removeEventListener("click", handleClick);
    installed = false;
  }
}
