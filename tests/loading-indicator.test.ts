import { LoadingIndicator } from "../dom/loading-indicator";

describe("LoadingIndicator", () => {
  let indicator: LoadingIndicator;

  beforeEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    indicator = new LoadingIndicator();
  });

  describe("show", () => {
    it("creates loading bar element", () => {
      indicator.show();

      const bars = document.body.querySelectorAll("div");
      expect(bars.length).toBe(1);

      const bar = bars[0];
      expect(bar.style.position).toBe("fixed");
      expect(bar.style.top).toBe("0px");
      expect(bar.style.zIndex).toBe("9999");
    });

    it("is idempotent - does not create duplicate bars", () => {
      indicator.show();
      indicator.show();
      indicator.show();

      const bars = document.body.querySelectorAll("div");
      expect(bars.length).toBe(1);
    });

    it("injects CSS keyframes only once", () => {
      indicator.show();
      indicator.hide();
      indicator.show();

      const styleElements = document.querySelectorAll("#lvt-loading-styles");
      expect(styleElements.length).toBe(1);
    });

    it("inserts bar as first child of body", () => {
      document.body.innerHTML = '<div id="existing">Existing content</div>';

      indicator.show();

      expect(document.body.firstChild).not.toBe(
        document.getElementById("existing")
      );
    });
  });

  describe("hide", () => {
    it("removes the bar", () => {
      indicator.show();
      expect(document.body.querySelectorAll("div").length).toBe(1);

      indicator.hide();
      expect(document.body.querySelectorAll("div").length).toBe(0);
    });

    it("is safe to call when no bar exists", () => {
      expect(() => indicator.hide()).not.toThrow();
    });

    it("allows show to create a new bar after hide", () => {
      indicator.show();
      indicator.hide();
      indicator.show();

      const bars = document.body.querySelectorAll("div");
      expect(bars.length).toBe(1);
    });

    it("the bar carries class lvt-loading-bar", () => {
      indicator.show();
      const bar = document.body.querySelector("div");
      expect(bar?.className).toBe("lvt-loading-bar");
    });
  });

  describe("enablePerActionIndicator", () => {
    afterEach(() => {
      indicator.disablePerActionIndicator();
      jest.useRealTimers();
    });

    it("shows after debounce on lvt:pending", () => {
      jest.useFakeTimers();
      indicator.enablePerActionIndicator(200);

      document.dispatchEvent(new CustomEvent("lvt:pending"));
      expect(document.querySelector(".lvt-loading-bar")).toBeNull();

      jest.advanceTimersByTime(199);
      expect(document.querySelector(".lvt-loading-bar")).toBeNull();

      jest.advanceTimersByTime(1);
      expect(document.querySelector(".lvt-loading-bar")).not.toBeNull();
    });

    it("hides on lvt:updated", () => {
      jest.useFakeTimers();
      indicator.enablePerActionIndicator(100);

      document.dispatchEvent(new CustomEvent("lvt:pending"));
      jest.advanceTimersByTime(100);
      expect(document.querySelector(".lvt-loading-bar")).not.toBeNull();

      document.dispatchEvent(new CustomEvent("lvt:updated"));
      expect(document.querySelector(".lvt-loading-bar")).toBeNull();
    });

    it("cancels timer when lvt:updated arrives before debounce elapses", () => {
      jest.useFakeTimers();
      indicator.enablePerActionIndicator(200);

      document.dispatchEvent(new CustomEvent("lvt:pending"));
      jest.advanceTimersByTime(100);
      document.dispatchEvent(new CustomEvent("lvt:updated"));

      jest.advanceTimersByTime(500);
      expect(document.querySelector(".lvt-loading-bar")).toBeNull();
    });

    it("ignores lvt:pending while a bar is already shown", () => {
      jest.useFakeTimers();
      indicator.enablePerActionIndicator(50);

      document.dispatchEvent(new CustomEvent("lvt:pending"));
      jest.advanceTimersByTime(50);
      expect(document.querySelectorAll(".lvt-loading-bar").length).toBe(1);

      document.dispatchEvent(new CustomEvent("lvt:pending"));
      jest.advanceTimersByTime(50);
      expect(document.querySelectorAll(".lvt-loading-bar").length).toBe(1);
    });

    it("re-arms cleanly across consecutive cycles", () => {
      jest.useFakeTimers();
      indicator.enablePerActionIndicator(50);

      for (let i = 0; i < 3; i++) {
        document.dispatchEvent(new CustomEvent("lvt:pending"));
        jest.advanceTimersByTime(50);
        expect(document.querySelector(".lvt-loading-bar")).not.toBeNull();
        document.dispatchEvent(new CustomEvent("lvt:updated"));
        expect(document.querySelector(".lvt-loading-bar")).toBeNull();
      }
    });

    it("is idempotent — repeat enables don't double-register", () => {
      jest.useFakeTimers();
      indicator.enablePerActionIndicator(50);
      indicator.enablePerActionIndicator(50);
      indicator.enablePerActionIndicator(50);

      document.dispatchEvent(new CustomEvent("lvt:pending"));
      jest.advanceTimersByTime(50);
      expect(document.querySelectorAll(".lvt-loading-bar").length).toBe(1);
    });

    it("reconfigures when called with a different debounce value", () => {
      // A caller that re-reads the attribute (after config change /
      // page reattach) expects the new debounce to take effect, not
      // silently inherit the prior one.
      jest.useFakeTimers();
      indicator.enablePerActionIndicator(500);
      indicator.enablePerActionIndicator(50); // new value should win

      document.dispatchEvent(new CustomEvent("lvt:pending"));
      jest.advanceTimersByTime(49);
      expect(document.querySelector(".lvt-loading-bar")).toBeNull();
      jest.advanceTimersByTime(1);
      expect(document.querySelector(".lvt-loading-bar")).not.toBeNull();
    });

    it("disablePerActionIndicator stops further reactions", () => {
      jest.useFakeTimers();
      indicator.enablePerActionIndicator(50);
      indicator.disablePerActionIndicator();

      document.dispatchEvent(new CustomEvent("lvt:pending"));
      jest.advanceTimersByTime(500);
      expect(document.querySelector(".lvt-loading-bar")).toBeNull();
    });

    it("keeps the bar visible until ALL concurrent actions complete", () => {
      // Concurrency repro: A starts → timer arms → bar shows. B starts.
      // B completes first — the bar must NOT disappear, because A is
      // still in flight. Bar should only hide once A's lvt:updated also
      // arrives. Without per-action reference counting, the first
      // lvt:updated would clear the bar prematurely.
      jest.useFakeTimers();
      indicator.enablePerActionIndicator(50);

      document.dispatchEvent(new CustomEvent("lvt:pending")); // A
      jest.advanceTimersByTime(50);
      expect(document.querySelector(".lvt-loading-bar")).not.toBeNull();

      document.dispatchEvent(new CustomEvent("lvt:pending")); // B
      document.dispatchEvent(new CustomEvent("lvt:updated")); // B done
      expect(document.querySelector(".lvt-loading-bar")).not.toBeNull();

      document.dispatchEvent(new CustomEvent("lvt:updated")); // A done
      expect(document.querySelector(".lvt-loading-bar")).toBeNull();
    });

    it("B still pending when A's debounce fires — bar appears, stays until B completes", () => {
      // A starts → timer arms. B starts mid-debounce. A completes
      // before the debounce expires; counter goes from 2 to 1, so the
      // timer is NOT cancelled and the bar shows when the debounce
      // elapses. The bar then stays visible until B also completes.
      jest.useFakeTimers();
      indicator.enablePerActionIndicator(200);

      document.dispatchEvent(new CustomEvent("lvt:pending")); // A
      jest.advanceTimersByTime(50);
      document.dispatchEvent(new CustomEvent("lvt:pending")); // B
      jest.advanceTimersByTime(50);
      document.dispatchEvent(new CustomEvent("lvt:updated")); // A done — count is now 1, not 0
      // Timer must still be armed — B is still pending.
      jest.advanceTimersByTime(150); // total = 250ms since A
      expect(document.querySelector(".lvt-loading-bar")).not.toBeNull();

      document.dispatchEvent(new CustomEvent("lvt:updated")); // B done — count back to 0
      expect(document.querySelector(".lvt-loading-bar")).toBeNull();
    });

    it("orphan lvt:updated (count already zero) is harmless", () => {
      // E.g. a server push, or a race where an updated event arrives
      // before our listener saw the corresponding pending.
      jest.useFakeTimers();
      indicator.enablePerActionIndicator(50);

      expect(() =>
        document.dispatchEvent(new CustomEvent("lvt:updated"))
      ).not.toThrow();

      // Subsequent normal cycle still works.
      document.dispatchEvent(new CustomEvent("lvt:pending"));
      jest.advanceTimersByTime(50);
      expect(document.querySelector(".lvt-loading-bar")).not.toBeNull();
      document.dispatchEvent(new CustomEvent("lvt:updated"));
      expect(document.querySelector(".lvt-loading-bar")).toBeNull();
    });
  });
});
