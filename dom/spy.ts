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
  // Pre-computed trigger-line distance from viewport top, in px.
  // Cached so the rAF-throttled scroll handler doesn't pay for a
  // synchronous style recalc (`getComputedStyle`) on every tick. The
  // window-resize listener re-computes this whenever the viewport
  // height changes (vh-based values shift).
  marginPx: number;
  scrollTarget: HTMLElement | Window;
  scrollHandler: () => void;
  resizeHandler: () => void;
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

// detach fully removes a binding's effects from the page: event
// listeners, the per-container guard, AND any lvt-active classes the
// binding had applied to its links. Folding the class-clear into detach
// means every caller (processContainer's re-attach, prune of
// disconnected containers, teardownSpy) gets the cleanup for free —
// without it, a stale lvt-active leaked anywhere detach was called but
// teardownSpy's surviving-id sweep wasn't (e.g. on every morphdom
// update that removed a target).
function detach(b: SpyBinding): void {
  applyActive(b, null);
  b.scrollTarget.removeEventListener(
    "scroll",
    b.scrollHandler as EventListener,
  );
  window.removeEventListener("resize", b.resizeHandler as EventListener);
  delete (b.container as any)[BINDING_KEY];
}

function readMarginPx(container: Element): number {
  const raw = getComputedStyle(container).getPropertyValue("--lvt-spy-margin").trim();
  const fallback = Math.round(window.innerHeight * 0.25);
  if (!raw) return fallback;
  const n = parseFloat(raw);
  if (isNaN(n)) return fallback;
  // Supported units: bare px (`200` or `200px`) and vh (`25vh`). Other
  // CSS units (rem, em, %, etc.) come through `getComputedStyle` as raw
  // strings, NOT resolved — `parseFloat("2rem")` returns 2 and we'd
  // silently treat it as 2 px, which is wildly off. Reject explicitly
  // and warn so the author fixes the declaration.
  if (raw.endsWith("vh")) return Math.round((n / 100) * window.innerHeight);
  // Accept "200" or "200.0" as unitless px (parseFloat strips zeros so
  // `raw === String(n)` would miss the latter). The regex pins the
  // entire string to a signed number, matching CSS's <number> grammar.
  if (raw.endsWith("px") || /^-?\d+(\.\d+)?$/.test(raw)) return n;
  console.warn(
    `lvt-spy: unsupported --lvt-spy-margin unit ${JSON.stringify(raw)}; supported units are vh and px (or unitless). Falling back to 25vh.`
  );
  return fallback;
}

function collectTargets(container: Element): Element[] {
  const selector = container.getAttribute("lvt-spy");
  if (selector && selector.trim() !== "") {
    // Guard against typos in author-supplied selectors. An invalid
    // selector (e.g. `lvt-spy="h1, h2,"` — trailing comma) makes
    // querySelectorAll throw SyntaxError, which would propagate out of
    // setupSpy and abort directive initialization for the whole scan
    // root. Warn and treat as empty so the rest of the page still works.
    try {
      return Array.from(container.querySelectorAll(selector));
    } catch (e) {
      console.warn(`lvt-spy: invalid selector ${JSON.stringify(selector)}:`, e);
      return [];
    }
  }
  return [container];
}

// applyActive updates lvt-active state for the links that belong to a
// single binding. Ownership is decided by href matching one of the
// binding's target ids — links pointing elsewhere (e.g. to a
// neighbouring spy container's targets) are left untouched. This is
// what lets multiple LiveTemplateClient mounts coexist on one page
// without their scroll-spy state stomping each other.
function applyActive(binding: SpyBinding, activeId: string | null): void {
  const ownIds = new Set<string>();
  for (const t of binding.targets) {
    if (t.id) ownIds.add(t.id);
  }
  document.querySelectorAll("[lvt-spy-link]").forEach((link) => {
    const href = link.getAttribute("href") || "";
    const id = href.startsWith("#") ? href.slice(1) : "";
    if (!ownIds.has(id)) return;
    if (activeId !== null && id === activeId) {
      link.classList.add(ACTIVE_CLASS);
    } else {
      link.classList.remove(ACTIVE_CLASS);
    }
  });
}

// findBindingForId locates the binding that owns the given id, i.e.
// has a target element whose id matches. Used by the optimistic click
// handler so a click on a link only updates its own binding's scope —
// other bindings' active links stay put.
function findBindingForId(id: string): SpyBinding | null {
  for (const b of activeBindings) {
    for (const t of b.targets) {
      if (t.id === id) return b;
    }
  }
  return null;
}

function pickActive(targets: Element[], marginPx: number): string | null {
  let activeId: string | null = null;
  // Walk every target. We deliberately do NOT bail early on the first
  // one below the trigger line — that optimisation assumes visual
  // top-to-bottom order (which holds for typical document flow) but
  // silently produces the wrong active link when targets are reordered
  // via CSS (sticky headers with negative top, transform: translateY,
  // flex/grid order). The full walk is O(n) with n = number of TOC
  // entries — small in practice, dwarfed by the rAF tick itself.
  for (const t of targets) {
    if (!t.id) continue;
    const top = t.getBoundingClientRect().top;
    if (top <= marginPx) {
      activeId = t.id;
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

  // Surface authoring mistakes once at attach time rather than letting
  // them silently produce a TOC entry that never lights up. A target
  // matched by the spy selector but missing `id` cannot be the
  // destination of `<a href="#...">`, so no link can ever activate for
  // it. Listing the elements (truncated) gives the author enough to
  // find the omission without spamming the console on every scroll.
  const missingId = targets.filter((t) => !t.id);
  if (missingId.length > 0) {
    console.warn(
      `lvt-spy: ${missingId.length} target(s) without an id attribute; they cannot be linked from [lvt-spy-link]. Add id="..." or drop them from the selector. First offender:`,
      missingId[0],
    );
  }

  const binding: SpyBinding = {
    container,
    targets,
    marginPx: readMarginPx(container),
    scrollTarget: findScrollTarget(container),
    // scrollHandler/resizeHandler are populated below — declared here so
    // the closures can reference `binding` for the cached margin lookup.
    scrollHandler: () => {},
    resizeHandler: () => {},
  };

  let ticking = false;
  binding.scrollHandler = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      applyActive(binding, pickActive(binding.targets, binding.marginPx));
    });
  };
  binding.resizeHandler = () => {
    // The trigger line is vh-relative (or px), so on viewport resize
    // we need to recompute. Refresh active immediately because resize
    // doesn't fire `scroll`, so the rAF path won't otherwise reconcile.
    binding.marginPx = readMarginPx(binding.container);
    applyActive(binding, pickActive(binding.targets, binding.marginPx));
  };

  binding.scrollTarget.addEventListener("scroll", binding.scrollHandler as EventListener, { passive: true });
  window.addEventListener("resize", binding.resizeHandler as EventListener, { passive: true });

  (container as any)[BINDING_KEY] = binding;
  activeBindings.push(binding);

  // Initial synchronous pick so the right link is highlighted on first
  // paint, before any scroll event fires.
  applyActive(binding, pickActive(binding.targets, binding.marginPx));
}

function processContainer(container: Element): void {
  const existing = (container as any)[BINDING_KEY] as SpyBinding | undefined;
  if (existing) {
    const fresh = collectTargets(container);
    if (sameTargets(existing.targets, fresh)) {
      // No structural change — just re-pick in case scroll position
      // shifted via a non-scroll mechanism (history restore, etc.).
      // Also refresh the cached margin in case CSS variables changed
      // between renders.
      existing.marginPx = readMarginPx(container);
      applyActive(existing, pickActive(existing.targets, existing.marginPx));
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
    // Route the optimistic flip to the binding that actually owns this
    // id. Otherwise clicking a link in TOC A would clear TOC B's
    // active highlight in a multi-instance layout.
    const owner = findBindingForId(id);
    if (owner) applyActive(owner, id);
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
  // detach() now clears each binding's lvt-active classes as part of
  // its contract, so there's no separate global sweep here — surviving
  // bindings keep their highlights, and removed bindings drop theirs.
  for (let i = activeBindings.length - 1; i >= 0; i--) {
    const b = activeBindings[i];
    if (wrapper && b.container.isConnected && !wrapper.contains(b.container)) {
      continue;
    }
    detach(b);
    activeBindings.splice(i, 1);
  }
  // Detach the document-level optimistic-click handler when there are
  // no more live spy bindings. Gating on `activeBindings.length === 0`
  // (instead of `!wrapper`) covers the common case where the framework
  // always passes a wrapper to teardown: without this gate the click
  // handler outlives every binding, and any subsequent [lvt-spy-link]
  // click silently re-applies lvt-active with no scroll reconciliation
  // to undo it.
  if (activeBindings.length === 0) {
    const handler = (document as any)[LINK_HANDLER_KEY];
    if (handler) {
      document.removeEventListener("click", handler);
      delete (document as any)[LINK_HANDLER_KEY];
    }
  }
}
