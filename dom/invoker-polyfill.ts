/**
 * Polyfill for the HTML Invoker Commands API (command/commandfor).
 * Enables <button command="show-modal" commandfor="dialog-id"> and
 * popover commands to work cross-browser.
 *
 * No-op when native support is detected.
 * Spec: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/command
 */

let installed = false;

function handleClick(e: Event): void {
  const el = e.target;
  if (!el || !(el instanceof Element)) return;

  const button = el.closest("button[commandfor]") as HTMLButtonElement | null;
  if (!button || button.disabled) return;

  const targetId = button.getAttribute("commandfor");
  if (!targetId) return;

  const command = button.getAttribute("command");
  const target = document.getElementById(targetId);
  if (!target) return;

  if (target instanceof HTMLDialogElement) {
    if (command === "show-modal" && !target.open) {
      target.showModal();
    } else if (command === "close" && target.open) {
      target.close();
    }
  } else if (target instanceof HTMLElement && target.hasAttribute("popover")) {
    if (command === "show-popover") {
      target.showPopover();
    } else if (command === "hide-popover") {
      target.hidePopover();
    } else if (command === "toggle-popover") {
      target.togglePopover();
    }
  }
}

export function setupInvokerPolyfill(): void {
  if ("commandForElement" in HTMLButtonElement.prototype) return;
  if (installed) return;

  installed = true;
  document.addEventListener("click", handleClick);
}

/** @internal Reset polyfill state. Test-only — do not call from production code. */
export function teardownInvokerPolyfill(): void {
  if (installed) {
    document.removeEventListener("click", handleClick);
    installed = false;
  }
}
