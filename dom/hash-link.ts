/**
 * Hash-driven element activation (deep-linking).
 *
 * Synchronizes the URL hash fragment with the open/close state of
 * <dialog>, [popover], and <details> elements. When the hash matches
 * an element's ID, the element is activated (showModal, showPopover,
 * or open=true). When the element deactivates, the hash is cleared.
 *
 * Uses history.pushState (not location.hash) to avoid triggering
 * hashchange events that could cause double-activation errors.
 */

interface HashLinkHandler {
  matches(el: Element): boolean;
  isOpen(el: Element): boolean;
  open(el: Element): void;
  close(el: Element): void;
}

const handlers: HashLinkHandler[] = [
  {
    matches: (el) => el instanceof HTMLDialogElement,
    isOpen: (el) => (el as HTMLDialogElement).open,
    open: (el) => (el as HTMLDialogElement).showModal(),
    close: (el) => (el as HTMLDialogElement).close(),
  },
  {
    matches: (el) =>
      el instanceof HTMLElement && el.hasAttribute("popover"),
    isOpen: (el) => {
      try {
        return (el as HTMLElement).matches(":popover-open");
      } catch {
        return false;
      }
    },
    open: (el) => {
      if (typeof (el as any).showPopover === "function")
        (el as HTMLElement).showPopover();
    },
    close: (el) => {
      if (typeof (el as any).hidePopover === "function")
        (el as HTMLElement).hidePopover();
    },
  },
  {
    matches: (el) => el instanceof HTMLDetailsElement,
    isOpen: (el) => (el as HTMLDetailsElement).open,
    open: (el) => {
      (el as HTMLDetailsElement).open = true;
    },
    close: (el) => {
      (el as HTMLDetailsElement).open = false;
    },
  },
];

function findHandler(el: Element): HashLinkHandler | undefined {
  return handlers.find((h) => h.matches(el));
}

const SHOW_COMMANDS = new Set(["show-modal", "show-popover"]);

function handleClick(e: Event): void {
  const el = e.target;
  if (!el || !(el instanceof Element)) return;

  const button = el.closest(
    "button[command][commandfor]"
  ) as HTMLButtonElement | null;
  if (!button || button.disabled) return;

  const command = button.getAttribute("command");
  if (!command) return;

  const targetId = button.getAttribute("commandfor");
  if (!targetId) return;

  const target = document.getElementById(targetId);
  if (!target) return;

  const handler = findHandler(target);
  if (!handler) return;

  if (SHOW_COMMANDS.has(command)) {
    if (location.hash === "#" + targetId) return;
    history.pushState(null, "", "#" + targetId);
  } else if (command === "toggle-popover" && !handler.isOpen(target)) {
    if (location.hash === "#" + targetId) return;
    history.pushState(null, "", "#" + targetId);
  }
}

function handleClose(e: Event): void {
  const el = e.target;
  if (!(el instanceof Element)) return;
  if (!el.id) return;
  if (!findHandler(el)) return;
  if (location.hash !== "#" + el.id) return;

  history.replaceState(null, "", location.pathname + location.search);
}

function handleToggle(e: Event): void {
  const el = e.target;
  if (!(el instanceof Element)) return;
  if (!el.id) return;

  const handler = findHandler(el);
  if (!handler) return;

  if (handler.isOpen(el)) {
    if (location.hash === "#" + el.id) return;
    history.pushState(null, "", "#" + el.id);
  } else {
    if (location.hash !== "#" + el.id) return;
    history.replaceState(null, "", location.pathname + location.search);
  }
}

function handlePopstate(): void {
  const id = location.hash.slice(1);

  document.querySelectorAll("dialog, [popover], details").forEach((el) => {
    const handler = findHandler(el);
    if (handler && handler.isOpen(el) && el.id !== id) handler.close(el);
  });

  if (id) {
    const el = document.getElementById(id);
    if (el) {
      const handler = findHandler(el);
      if (handler && !handler.isOpen(el)) handler.open(el);
    }
  }
}

export function openFromHash(): void {
  const id = location.hash.slice(1);
  if (!id) return;

  const el = document.getElementById(id);
  if (!el) return;

  const handler = findHandler(el);
  if (!handler) return;
  if (handler.isOpen(el)) return;

  handler.open(el);
}

export function isHashLinkTarget(id: string): boolean {
  const el = document.getElementById(id);
  if (!el) return false;
  return !!findHandler(el);
}

export function activateHashTarget(id: string): void {
  const el = document.getElementById(id);
  if (!el) return;

  const handler = findHandler(el);
  if (!handler || handler.isOpen(el)) return;

  history.pushState(null, "", "#" + id);
  handler.open(el);
}

let installed = false;

export function setupHashLink(): void {
  if (installed) return;
  installed = true;

  document.addEventListener("click", handleClick);
  document.addEventListener("close", handleClose, true);
  document.addEventListener("toggle", handleToggle, true);
  window.addEventListener("popstate", handlePopstate);

  openFromHash();
}

/** @internal Remove all hash-link event listeners. */
export function teardownHashLink(): void {
  if (!installed) return;
  installed = false;

  document.removeEventListener("click", handleClick);
  document.removeEventListener("close", handleClose, true);
  document.removeEventListener("toggle", handleToggle, true);
  window.removeEventListener("popstate", handlePopstate);
}
