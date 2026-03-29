import { FocusManager } from "../dom/focus-manager";
import { FOCUSABLE_INPUTS } from "../constants";
import { createLogger } from "../utils/logger";

function createManager(): FocusManager {
  return new FocusManager(
    createLogger({ scope: "FocusManagerTest", level: "silent" })
  );
}

describe("FocusManager", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("restores focus to the last tracked element", () => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-lvt-id", "focus-wrapper");

    const input = document.createElement("input");
    input.type = "text";
    wrapper.appendChild(input);

    document.body.appendChild(wrapper);

    const manager = new FocusManager(
      createLogger({ scope: "FocusManagerTest", level: "silent" })
    );
    manager.attach(wrapper);
    manager.updateFocusableElements();

    (manager as any).lastFocusedElement = input;
    (manager as any).wrapperElement = wrapper;
    (manager as any).lastFocusedSelectionStart = 1;
    (manager as any).lastFocusedSelectionEnd = 3;

    manager.restoreFocusedElement();

    expect(document.activeElement).toBe(input);
  });

  it("does not reset cursor when element retained focus", () => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-lvt-id", "focus-wrapper-cursor");

    const input = document.createElement("input");
    input.type = "text";
    wrapper.appendChild(input);
    document.body.appendChild(wrapper);

    const manager = createManager();
    manager.attach(wrapper);

    // Simulate: user focuses input (cursor at 0), then types "hello" (cursor at 5)
    (manager as any).lastFocusedElement = input;
    (manager as any).lastFocusedSelectionStart = 0;
    (manager as any).lastFocusedSelectionEnd = 0;

    input.focus();
    input.value = "hello";
    input.setSelectionRange(5, 5);

    // restoreFocusedElement should NOT clobber the current cursor position
    manager.restoreFocusedElement();

    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(5);
    expect(input.selectionEnd).toBe(5);
  });

  it("restores cursor when element lost focus (morphdom replacement)", () => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-lvt-id", "focus-wrapper-replace");

    const input1 = document.createElement("input");
    input1.type = "text";
    input1.setAttribute("name", "title");
    wrapper.appendChild(input1);
    document.body.appendChild(wrapper);

    const manager = createManager();
    manager.attach(wrapper);

    (manager as any).lastFocusedElement = input1;
    (manager as any).lastFocusedSelectionStart = 3;
    (manager as any).lastFocusedSelectionEnd = 3;

    // Simulate morphdom replacing the element (new DOM node, focus lost)
    wrapper.removeChild(input1);
    const input2 = document.createElement("input");
    input2.type = "text";
    input2.setAttribute("name", "title");
    input2.value = "hello";
    wrapper.appendChild(input2);

    manager.restoreFocusedElement();

    expect(document.activeElement).toBe(input2);
    expect(input2.selectionStart).toBe(3);
    expect(input2.selectionEnd).toBe(3);
  });

  it("fails gracefully when the tracked element no longer exists", () => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-lvt-id", "focus-wrapper-2");

    const input = document.createElement("input");
    wrapper.appendChild(input);
    document.body.appendChild(wrapper);

    const manager = new FocusManager(
      createLogger({ scope: "FocusManagerTest", level: "silent" })
    );
    manager.attach(wrapper);
    manager.updateFocusableElements();

    (manager as any).lastFocusedElement = input;
    (manager as any).wrapperElement = wrapper;

    input.remove();

    expect(() => manager.restoreFocusedElement()).not.toThrow();
    expect(document.activeElement).not.toBe(input);
  });

  describe("shouldSkipUpdate", () => {
    let manager: FocusManager;

    beforeEach(() => {
      manager = createManager();
    });

    it("returns true for focused text input", () => {
      const input = document.createElement("input");
      input.type = "text";
      document.body.appendChild(input);
      input.focus();

      expect(manager.shouldSkipUpdate(input)).toBe(true);
    });

    it("returns true for focused textarea", () => {
      const textarea = document.createElement("textarea");
      document.body.appendChild(textarea);
      textarea.focus();

      expect(manager.shouldSkipUpdate(textarea)).toBe(true);
    });

    it("returns true for focused select", () => {
      const select = document.createElement("select");
      document.body.appendChild(select);
      select.focus();

      expect(manager.shouldSkipUpdate(select)).toBe(true);
    });

    it("returns false for non-focused element", () => {
      const input1 = document.createElement("input");
      input1.type = "text";
      const input2 = document.createElement("input");
      input2.type = "text";
      document.body.appendChild(input1);
      document.body.appendChild(input2);
      input1.focus();

      expect(manager.shouldSkipUpdate(input2)).toBe(false);
    });

    it("returns false when no element is focused", () => {
      const input = document.createElement("input");
      input.type = "text";
      document.body.appendChild(input);

      expect(manager.shouldSkipUpdate(input)).toBe(false);
    });

    it("returns false for focused element with data-lvt-force-update", () => {
      const input = document.createElement("input");
      input.type = "text";
      input.setAttribute("data-lvt-force-update", "");
      document.body.appendChild(input);
      input.focus();

      expect(manager.shouldSkipUpdate(input)).toBe(false);
    });

    it("returns false for focused button", () => {
      const button = document.createElement("button");
      document.body.appendChild(button);
      button.focus();

      expect(manager.shouldSkipUpdate(button)).toBe(false);
    });

    it("returns false after element is blurred", () => {
      const input = document.createElement("input");
      input.type = "text";
      document.body.appendChild(input);
      input.focus();
      expect(manager.shouldSkipUpdate(input)).toBe(true);

      input.blur();
      expect(manager.shouldSkipUpdate(input)).toBe(false);
    });

    it.each(
      FOCUSABLE_INPUTS.filter((t) => t !== "textarea").map((type) => [type])
    )("returns true for focused input[type=%s]", (type) => {
      const input = document.createElement("input");
      input.type = type;
      document.body.appendChild(input);
      input.focus();

      expect(manager.shouldSkipUpdate(input)).toBe(true);
    });
  });
});
