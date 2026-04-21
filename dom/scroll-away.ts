import { resolveTarget } from "./reactive-attributes";

interface ScrollAwayBinding {
  trigger: Element;
  target: Element;
  handler: () => void;
}

const GUARD_KEY = "__lvt_scroll_away";

const activeBindings: ScrollAwayBinding[] = [];

export function setupScrollAway(scanRoot: Element): void {
  const processEl = (el: Element) => {
    const edge = el.getAttribute("lvt-scroll-away");
    if (!edge) return;
    if (edge !== "bottom") {
      console.warn(`Unknown lvt-scroll-away edge: ${edge}`);
      return;
    }

    const target = resolveTarget(el) as HTMLElement;
    if (!target || target === el) return;

    const existing = (el as any)[GUARD_KEY] as ScrollAwayBinding | undefined;
    if (existing) {
      if (existing.target === target) return;
      existing.target.removeEventListener("scroll", existing.handler);
      removeBinding(existing);
    }

    const threshold = parseInt(
      getComputedStyle(el).getPropertyValue("--lvt-scroll-threshold").trim() || "200",
      10
    );

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
    if (wrapper && !wrapper.contains(binding.trigger)) continue;
    binding.target.removeEventListener("scroll", binding.handler);
    delete (binding.trigger as any)[GUARD_KEY];
    activeBindings.splice(i, 1);
  }
}
