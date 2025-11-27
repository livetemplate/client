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
  });
});
