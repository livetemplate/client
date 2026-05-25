/**
 * Scroll-spy directive.
 *
 * Highlights navigation links as the user scrolls past corresponding section
 * targets. Pure client-side state — no server round-trip per scroll tick.
 *
 *   <article lvt-spy="h1, h2, h3">           // container mode: descendants
 *     <h1 id="intro">Intro</h1>                  matching the selector are
 *     <h2 id="usage">Usage</h2>                  the spy targets.
 *   </article>
 *
 *   <h2 id="other" lvt-spy>Other</h2>         // element mode: this element
 *                                                IS the target. Empty value.
 *
 *   <a href="#intro" lvt-spy-link>Intro</a>   // gets the `lvt-active` class
 *   <a href="#usage" lvt-spy-link>Usage</a>      when its href="#<id>" matches
 *                                                the currently active target.
 *
 * Activation rule: walk targets in document order; the latest one whose top
 * edge has scrolled above a trigger line near the top of the viewport is
 * active. That way the first link stays active until the reader has actually
 * passed the first heading, and the active link advances in step with the
 * reader.
 *
 * Configuration via CSS custom property on the spy container:
 *   --lvt-spy-margin: <length>   (default: 25vh from the top)
 *     The trigger line below the viewport top. A target counts as "passed"
 *     once its top edge is at or above this line.
 *
 * Implementation: a rAF-throttled scroll listener on the nearest scrollable
 * ancestor (or window). Mirrors the lifecycle shape of `scroll-away.ts` so
 * the morphdom re-scan story is identical.
 */

const ACTIVE_CLASS = "lvt-active";
const BINDING_KEY = "__lvt_spy";
const LINK_HANDLER_KEY = "__lvt_spy_link_handler";

interface SpyBinding {
  container: Element;
  targets: Element[];
  scrollTarget: HTMLElement | Window;
  scrollHandler: () => void;
}

const activeBindings: SpyBinding[] = [];

function pruneDisconnectedBindings(): void {
  for (let i = activeBindings.length - 1; i >= 0; i--) {
    const b = activeBindings[i];
    if (b.container.isConnected) continue;
    detach(b);
    activeBindings.splice(i, 1);
  }
}

function detach(b: SpyBinding): void {
  b.scrollTarget.removeEventListener(
    "scroll",
    b.scrollHandler as EventListener,
  );
  delete (b.container as any)[BINDING_KEY];
}

function readMarginPx(container: Element): number {
  const raw = getComputedStyle(container).getPropertyValue("--lvt-spy-margin").trim();
  const fallback = Math.round(window.innerHeight * 0.25);
  if (!raw) return fallback;
  if (raw.endsWith("vh")) {
    const n = parseFloat(raw);
    return isNaN(n) ? fallback : Math.round((n / 100) * window.innerHeight);
  }
  const n = parseFloat(raw);
  return isNaN(n) ? fallback : n;
}

function collectTargets(container: Element): Element[] {
  const selector = container.getAttribute("lvt-spy");
  if (selector && selector.trim() !== "") {
    return Array.from(container.querySelectorAll(selector));
  }
  return [container];
}

function applyActive(activeId: string | null): void {
  const links = document.querySelectorAll("[lvt-spy-link]");
  links.forEach((link) => {
    const href = link.getAttribute("href") || "";
    const id = href.startsWith("#") ? href.slice(1) : "";
    if (activeId !== null && id === activeId) {
      link.classList.add(ACTIVE_CLASS);
    } else {
      link.classList.remove(ACTIVE_CLASS);
    }
  });
}

function pickActive(container: Element, targets: Element[]): string | null {
  const margin = readMarginPx(container);
  let activeId: string | null = null;
  // Document order, accumulate the most recent target whose top is above
  // the trigger line. Bail early on the first one still below.
  for (const t of targets) {
    if (!t.id) continue;
    const top = t.getBoundingClientRect().top;
    if (top <= margin) {
      activeId = t.id;
    } else {
      break;
    }
  }
  return activeId;
}

function findScrollTarget(el: Element): HTMLElement | Window {
  // Walk up to the nearest ancestor whose computed overflow-y is auto or
  // scroll. If none, the document scrolls — return window. Covers both
  // the common whole-document case and apps where a flex child scrolls
  // independently (prereview's main.viewer).
  let cur: Element | null = el.parentElement;
  while (cur && cur !== document.documentElement) {
    const oy = getComputedStyle(cur).overflowY;
    if (oy === "auto" || oy === "scroll") return cur as HTMLElement;
    cur = cur.parentElement;
  }
  return window;
}

function sameTargets(a: Element[], b: Element[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function attach(container: Element): void {
  const targets = collectTargets(container);
  if (targets.length === 0) return;

  let ticking = false;
  const scrollHandler = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      applyActive(pickActive(container, targets));
    });
  };

  const scrollTarget = findScrollTarget(container);
  scrollTarget.addEventListener("scroll", scrollHandler as EventListener, { passive: true });

  const binding: SpyBinding = { container, targets, scrollTarget, scrollHandler };
  (container as any)[BINDING_KEY] = binding;
  activeBindings.push(binding);

  // Initial synchronous pick so the right link is highlighted on first
  // paint, before any scroll event fires.
  applyActive(pickActive(container, targets));
}

function processContainer(container: Element): void {
  const existing = (container as any)[BINDING_KEY] as SpyBinding | undefined;
  if (existing) {
    const fresh = collectTargets(container);
    if (sameTargets(existing.targets, fresh)) {
      // No structural change — just re-pick in case scroll position
      // shifted via a non-scroll mechanism (history restore, etc.).
      applyActive(pickActive(container, existing.targets));
      return;
    }
    detach(existing);
    const idx = activeBindings.indexOf(existing);
    if (idx !== -1) activeBindings.splice(idx, 1);
  }
  attach(container);
}

function installLinkClickHandler(): void {
  if ((document as any)[LINK_HANDLER_KEY]) return;
  // Optimistic activation: clicking a link instantly applies lvt-active
  // to it. The next scroll-driven pick reconciles. Without this, clicking
  // the *last* heading (which may never become topmost-visible if the
  // doc ends shortly after it) would leave some earlier link highlighted
  // even though the user just asked to be at the last heading.
  const handler = (e: Event) => {
    const link = (e.target as Element | null)?.closest("[lvt-spy-link]");
    if (!link) return;
    const href = link.getAttribute("href") || "";
    const id = href.startsWith("#") ? href.slice(1) : "";
    if (!id) return;
    applyActive(id);
  };
  document.addEventListener("click", handler);
  (document as any)[LINK_HANDLER_KEY] = handler;
}

export function setupSpy(scanRoot: Element): void {
  pruneDisconnectedBindings();
  installLinkClickHandler();

  if (scanRoot.hasAttribute("lvt-spy")) {
    processContainer(scanRoot);
  }
  scanRoot.querySelectorAll("[lvt-spy]").forEach(processContainer);
}

export function teardownSpy(wrapper?: Element): void {
  for (let i = activeBindings.length - 1; i >= 0; i--) {
    const b = activeBindings[i];
    if (wrapper && b.container.isConnected && !wrapper.contains(b.container)) {
      continue;
    }
    detach(b);
    activeBindings.splice(i, 1);
  }
  const scope: ParentNode = wrapper ?? document;
  scope.querySelectorAll(`[lvt-spy-link].${ACTIVE_CLASS}`).forEach((el) => {
    el.classList.remove(ACTIVE_CLASS);
  });
  if (!wrapper) {
    const handler = (document as any)[LINK_HANDLER_KEY];
    if (handler) {
      document.removeEventListener("click", handler);
      delete (document as any)[LINK_HANDLER_KEY];
    }
  }
}
