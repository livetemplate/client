import { resolveTarget } from "./reactive-attributes";

interface ScrollAwayBinding {
  trigger: Element;
  target: Element;
  handler: () => void;
}

const GUARD_KEY = "__lvt_scroll_away";

const activeBindings: ScrollAwayBinding[] = [];

function pruneDisconnectedBindings(): void {
  for (let i = activeBindings.length - 1; i >= 0; i--) {
    const binding = activeBindings[i];
    if (binding.trigger.isConnected) continue;
    binding.target.removeEventListener("scroll", binding.handler);
    delete (binding.trigger as any)[GUARD_KEY];
    activeBindings.splice(i, 1);
  }
}

export function setupScrollAway(scanRoot: Element): void {
  pruneDisconnectedBindings();

  const processEl = (el: Element) => {
    const edge = el.getAttribute("lvt-scroll-away");
    if (!edge) return;
    if (edge !== "bottom") {
      console.warn(`Unknown lvt-scroll-away edge: ${edge}`);
      return;
    }

    const target = resolveTarget(el) as HTMLElement;
    if (!target || target === el) {
      const existing = (el as any)[GUARD_KEY] as ScrollAwayBinding | undefined;
      if (existing) {
        existing.target.removeEventListener("scroll", existing.handler);
        removeBinding(existing);
        delete (el as any)[GUARD_KEY];
      }
      console.warn("lvt-scroll-away requires data-lvt-target pointing to a scrollable container");
      return;
    }

    const existing = (el as any)[GUARD_KEY] as ScrollAwayBinding | undefined;
    if (existing) {
      if (existing.target === target) return;
      existing.target.removeEventListener("scroll", existing.handler);
      removeBinding(existing);
    }

    const raw = parseInt(
      getComputedStyle(el).getPropertyValue("--lvt-scroll-threshold").trim(), 10
    );
    const threshold = isNaN(raw) ? 200 : raw;

    let ticking = false;
    const handler = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const distance = target.scrollHeight - target.scrollTop - target.clientHeight;
        if (distance > threshold) {
          el.classList.add("visible");
        } else {
          el.classList.remove("visible");
        }
      });
    };

    target.addEventListener("scroll", handler, { passive: true });
    handler();

    const binding: ScrollAwayBinding = { trigger: el, target, handler };
    (el as any)[GUARD_KEY] = binding;
    activeBindings.push(binding);
  };

  processEl(scanRoot);
  scanRoot.querySelectorAll("[lvt-scroll-away]").forEach(processEl);
}

function removeBinding(binding: ScrollAwayBinding): void {
  const idx = activeBindings.indexOf(binding);
  if (idx !== -1) activeBindings.splice(idx, 1);
}

export function teardownScrollAway(wrapper?: Element): void {
  for (let i = activeBindings.length - 1; i >= 0; i--) {
    const binding = activeBindings[i];
    if (wrapper && binding.trigger.isConnected && !wrapper.contains(binding.trigger)) continue;
    binding.target.removeEventListener("scroll", binding.handler);
    binding.trigger.classList.remove("visible");
    delete (binding.trigger as any)[GUARD_KEY];
    activeBindings.splice(i, 1);
  }
}
