import { ChangeAutoWirer } from "../state/change-auto-wirer";
import type { ChangeAutoWirerContext } from "../state/change-auto-wirer";
import { createLogger } from "../utils/logger";

describe("ChangeAutoWirer", () => {
  let wirer: ChangeAutoWirer;
  let sendSpy: jest.Mock;
  let wrapper: HTMLDivElement;

  const createContext = (): ChangeAutoWirerContext => ({
    getWrapperElement: () => wrapper,
    send: sendSpy,
  });

  beforeEach(() => {
    jest.useFakeTimers();
    sendSpy = jest.fn();
    wrapper = document.createElement("div");
    document.body.appendChild(wrapper);
    const logger = createLogger({ scope: "ChangeAutoWirerTest", level: "silent" });
    wirer = new ChangeAutoWirer(createContext(), logger);
  });

  afterEach(() => {
    wirer.teardown();
    document.body.innerHTML = "";
    jest.useRealTimers();
  });

  // ===== Statics Analysis =====

  describe("analyzeStatics", () => {
    it("detects value-bound input", () => {
      wirer.analyzeStatics({
        s: ['<input name="Title" value="', '">'],
        "0": "current value",
      });

      const fields = wirer.getBoundFields();
      expect(fields.size).toBe(1);
      expect(fields.get("Title")).toBe("value");
    });

    it("detects value-bound input with extra attributes", () => {
      wirer.analyzeStatics({
        s: ['<input type="text" class="form-control" name="Title" id="title-input" value="', '">'],
        "0": "current value",
      });

      const fields = wirer.getBoundFields();
      expect(fields.size).toBe(1);
      expect(fields.get("Title")).toBe("value");
    });

    it("detects textarea content binding", () => {
      wirer.analyzeStatics({
        s: ['<textarea name="Bio">', "</textarea>"],
        "0": "bio content",
      });

      const fields = wirer.getBoundFields();
      expect(fields.size).toBe(1);
      expect(fields.get("Bio")).toBe("content");
    });

    it("detects textarea with extra attributes", () => {
      wirer.analyzeStatics({
        s: ['<textarea class="big" name="Bio" rows="5">', "</textarea>"],
        "0": "bio content",
      });

      const fields = wirer.getBoundFields();
      expect(fields.size).toBe(1);
      expect(fields.get("Bio")).toBe("content");
    });

    it("detects checkbox attribute binding", () => {
      wirer.analyzeStatics({
        s: ['<input type="checkbox" name="Active" ', ">"],
        "0": "checked",
      });

      const fields = wirer.getBoundFields();
      expect(fields.size).toBe(1);
      expect(fields.get("Active")).toBe("attribute");
    });

    it("does NOT detect static-only inputs", () => {
      wirer.analyzeStatics({
        s: ['<input name="csrf" value="token123"><input name="Title" value="', '">'],
        "0": "dynamic",
      });

      const fields = wirer.getBoundFields();
      // Only Title should be detected, not csrf
      expect(fields.size).toBe(1);
      expect(fields.has("csrf")).toBe(false);
      expect(fields.has("Title")).toBe(true);
    });

    it("handles multiple bound fields", () => {
      wirer.analyzeStatics({
        s: [
          '<input name="Title" value="',
          '"><textarea name="Bio">',
          '</textarea><input type="checkbox" name="Active" ',
          ">",
        ],
        "0": "title",
        "1": "bio",
        "2": "checked",
      });

      const fields = wirer.getBoundFields();
      expect(fields.size).toBe(3);
      expect(fields.has("Title")).toBe(true);
      expect(fields.has("Bio")).toBe(true);
      expect(fields.has("Active")).toBe(true);
    });

    it("handles nested tree structures", () => {
      wirer.analyzeStatics({
        s: ["<div>", "</div>"],
        "0": {
          s: ['<input name="Name" value="', '">'],
          "0": "nested value",
        },
      });

      const fields = wirer.getBoundFields();
      expect(fields.size).toBe(1);
      expect(fields.has("Name")).toBe(true);
    });

    it("handles range structures with form inputs", () => {
      wirer.analyzeStatics({
        s: ["<ul>", "</ul>"],
        "0": {
          d: [
            { "0": "item1", _k: "1" },
            { "0": "item2", _k: "2" },
          ],
          s: ['<li><input name="Item" value="', '"></li>'],
        },
      });

      const fields = wirer.getBoundFields();
      expect(fields.size).toBe(1);
      expect(fields.has("Item")).toBe(true);
    });

    it("returns empty for tree with no form inputs", () => {
      wirer.analyzeStatics({
        s: ["<div>", "</div>"],
        "0": "just text",
      });

      expect(wirer.getBoundFields().size).toBe(0);
    });

    it("does not detect value binding when > appears between tag start and end", () => {
      // The value=" is after a >, so it's not inside the same tag as name=
      wirer.analyzeStatics({
        s: ['<div name="Foo">some text<span value="', '">'],
        "0": "val",
      });

      // name="Foo" is in a <div> tag that is already closed
      // value=" is in a <span> tag without name=
      expect(wirer.getBoundFields().size).toBe(0);
    });
  });

  // ===== Capabilities =====

  describe("setCapabilities", () => {
    it("enables when capabilities include 'change'", () => {
      wirer.setCapabilities(["change"]);
      expect(wirer.isEnabled()).toBe(true);
    });

    it("stays disabled when capabilities don't include 'change'", () => {
      wirer.setCapabilities(["other"]);
      expect(wirer.isEnabled()).toBe(false);
    });

    it("stays disabled with empty capabilities", () => {
      wirer.setCapabilities([]);
      expect(wirer.isEnabled()).toBe(false);
    });
  });

  // ===== DOM Wiring =====

  describe("wireElements", () => {
    const setupWirer = (statics: any) => {
      wirer.setCapabilities(["change"]);
      wirer.analyzeStatics(statics);
    };

    it("wires input element and sends change on input event", () => {
      const input = document.createElement("input");
      input.setAttribute("name", "Title");
      input.value = "old";
      wrapper.appendChild(input);

      setupWirer({
        s: ['<input name="Title" value="', '">'],
        "0": "old",
      });

      wirer.wireElements();

      input.value = "new value";
      input.dispatchEvent(new Event("input", { bubbles: true }));

      // Advance past debounce
      jest.advanceTimersByTime(300);

      expect(sendSpy).toHaveBeenCalledWith({
        action: "change",
        data: { Title: "new value" },
      });
    });

    it("debounces input events at 300ms default", () => {
      const input = document.createElement("input");
      input.setAttribute("name", "Title");
      wrapper.appendChild(input);

      setupWirer({
        s: ['<input name="Title" value="', '">'],
        "0": "",
      });

      wirer.wireElements();

      // Rapid typing
      input.value = "a";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      jest.advanceTimersByTime(100);

      input.value = "ab";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      jest.advanceTimersByTime(100);

      input.value = "abc";
      input.dispatchEvent(new Event("input", { bubbles: true }));

      // Not yet fired
      expect(sendSpy).not.toHaveBeenCalled();

      // Advance past debounce
      jest.advanceTimersByTime(300);

      // Should have been called once with the latest value
      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(sendSpy).toHaveBeenCalledWith({
        action: "change",
        data: { Title: "abc" },
      });
    });

    it("respects lvt-debounce override", () => {
      const input = document.createElement("input");
      input.setAttribute("name", "Title");
      input.setAttribute("lvt-debounce", "500");
      wrapper.appendChild(input);

      setupWirer({
        s: ['<input name="Title" value="', '">'],
        "0": "",
      });

      wirer.wireElements();

      input.value = "test";
      input.dispatchEvent(new Event("input", { bubbles: true }));

      // 300ms: default debounce would fire, but custom is 500
      jest.advanceTimersByTime(300);
      expect(sendSpy).not.toHaveBeenCalled();

      // 500ms: custom debounce fires
      jest.advanceTimersByTime(200);
      expect(sendSpy).toHaveBeenCalledTimes(1);
    });

    it("skips elements with lvt-input attribute", () => {
      const input = document.createElement("input");
      input.setAttribute("name", "Title");
      input.setAttribute("lvt-input", "search");
      wrapper.appendChild(input);

      setupWirer({
        s: ['<input name="Title" value="', '">'],
        "0": "",
      });

      wirer.wireElements();

      input.value = "test";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      jest.advanceTimersByTime(300);

      expect(sendSpy).not.toHaveBeenCalled();
    });

    it("skips elements with lvt-change attribute", () => {
      const input = document.createElement("input");
      input.setAttribute("name", "Title");
      input.setAttribute("lvt-change", "filter");
      wrapper.appendChild(input);

      setupWirer({
        s: ['<input name="Title" value="', '">'],
        "0": "",
      });

      wirer.wireElements();

      input.value = "test";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      jest.advanceTimersByTime(300);

      expect(sendSpy).not.toHaveBeenCalled();
    });

    it("skips elements inside form with lvt-change", () => {
      const form = document.createElement("form");
      form.setAttribute("lvt-change", "change");
      const input = document.createElement("input");
      input.setAttribute("name", "Title");
      form.appendChild(input);
      wrapper.appendChild(form);

      setupWirer({
        s: ['<input name="Title" value="', '">'],
        "0": "",
      });

      wirer.wireElements();

      input.value = "test";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      jest.advanceTimersByTime(300);

      expect(sendSpy).not.toHaveBeenCalled();
    });

    it("skips elements inside form with lvt-form:no-intercept", () => {
      const form = document.createElement("form");
      form.setAttribute("lvt-form:no-intercept", "");
      const input = document.createElement("input");
      input.setAttribute("name", "Title");
      form.appendChild(input);
      wrapper.appendChild(form);

      setupWirer({
        s: ['<input name="Title" value="', '">'],
        "0": "",
      });

      wirer.wireElements();

      input.value = "test";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      jest.advanceTimersByTime(300);

      expect(sendSpy).not.toHaveBeenCalled();
    });

    it("skips hidden inputs", () => {
      const input = document.createElement("input");
      input.type = "hidden";
      input.setAttribute("name", "ID");
      input.value = "123";
      wrapper.appendChild(input);

      setupWirer({
        s: ['<input type="hidden" name="ID" value="', '">'],
        "0": "123",
      });

      wirer.wireElements();

      input.value = "456";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      jest.advanceTimersByTime(300);

      expect(sendSpy).not.toHaveBeenCalled();
    });

    it("skips submit and button inputs", () => {
      const submit = document.createElement("input");
      submit.type = "submit";
      submit.setAttribute("name", "Save");
      wrapper.appendChild(submit);

      const button = document.createElement("input");
      button.type = "button";
      button.setAttribute("name", "Cancel");
      wrapper.appendChild(button);

      setupWirer({
        s: ['<input type="submit" name="Save" value="', '"><input type="button" name="Cancel" value="', '">'],
        "0": "Save",
        "1": "Cancel",
      });

      wirer.wireElements();

      submit.dispatchEvent(new Event("input", { bubbles: true }));
      submit.dispatchEvent(new Event("change", { bubbles: true }));
      button.dispatchEvent(new Event("input", { bubbles: true }));
      button.dispatchEvent(new Event("change", { bubbles: true }));
      jest.advanceTimersByTime(300);

      expect(sendSpy).not.toHaveBeenCalled();
    });

    it("skips button elements", () => {
      const btn = document.createElement("button");
      btn.setAttribute("name", "Action");
      wrapper.appendChild(btn);

      setupWirer({
        s: ['<button name="Action" value="', '">Do</button>'],
        "0": "do",
      });

      wirer.wireElements();

      btn.dispatchEvent(new Event("input", { bubbles: true }));
      btn.dispatchEvent(new Event("change", { bubbles: true }));
      jest.advanceTimersByTime(300);

      expect(sendSpy).not.toHaveBeenCalled();
    });

    it("handles checkbox inputs (sends boolean)", () => {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.setAttribute("name", "Active");
      wrapper.appendChild(checkbox);

      setupWirer({
        s: ['<input type="checkbox" name="Active" ', ">"],
        "0": "checked",
      });

      wirer.wireElements();

      checkbox.checked = true;
      // Checkboxes use 'change' event
      checkbox.dispatchEvent(new Event("change", { bubbles: true }));

      jest.advanceTimersByTime(300);

      expect(sendSpy).toHaveBeenCalledWith({
        action: "change",
        data: { Active: true },
      });
    });

    it("handles radio buttons (sends value, not boolean)", () => {
      const radio1 = document.createElement("input");
      radio1.type = "radio";
      radio1.setAttribute("name", "Color");
      radio1.value = "red";
      wrapper.appendChild(radio1);

      const radio2 = document.createElement("input");
      radio2.type = "radio";
      radio2.setAttribute("name", "Color");
      radio2.value = "blue";
      wrapper.appendChild(radio2);

      setupWirer({
        s: ['<input type="radio" name="Color" ', ">"],
        "0": "checked",
      });

      wirer.wireElements();

      radio2.checked = true;
      radio2.dispatchEvent(new Event("change", { bubbles: true }));

      jest.advanceTimersByTime(300);

      expect(sendSpy).toHaveBeenCalledWith({
        action: "change",
        data: { Color: "blue" },
      });
    });

    it("handles textarea elements", () => {
      const textarea = document.createElement("textarea");
      textarea.setAttribute("name", "Bio");
      textarea.value = "old bio";
      wrapper.appendChild(textarea);

      setupWirer({
        s: ['<textarea name="Bio">', "</textarea>"],
        "0": "old bio",
      });

      wirer.wireElements();

      textarea.value = "new bio";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));

      jest.advanceTimersByTime(300);

      expect(sendSpy).toHaveBeenCalledWith({
        action: "change",
        data: { Bio: "new bio" },
      });
    });

    // ===== Select Auto-Wiring =====
    // Selects are auto-wired by name when Change() is enabled, without
    // needing a static binding (bindings are on child <option> tags).

    it("auto-wires named select without static binding", () => {
      const select = document.createElement("select");
      select.setAttribute("name", "sort_by");
      const opt1 = document.createElement("option");
      opt1.value = "";
      opt1.textContent = "Newest First";
      const opt2 = document.createElement("option");
      opt2.value = "alphabetical";
      opt2.textContent = "A-Z";
      select.appendChild(opt1);
      select.appendChild(opt2);
      wrapper.appendChild(select);

      // No statics reference the select — only enable capabilities
      wirer.setCapabilities(["change"]);

      wirer.wireElements();

      select.value = "alphabetical";
      select.dispatchEvent(new Event("change", { bubbles: true }));

      jest.advanceTimersByTime(300);

      expect(sendSpy).toHaveBeenCalledWith({
        action: "change",
        data: { sort_by: "alphabetical" },
      });
    });

    it("auto-wires select alongside bound inputs", () => {
      const input = document.createElement("input");
      input.setAttribute("name", "Title");
      wrapper.appendChild(input);

      const select = document.createElement("select");
      select.setAttribute("name", "Category");
      const optA = document.createElement("option");
      optA.value = "a";
      optA.textContent = "A";
      const optB = document.createElement("option");
      optB.value = "b";
      optB.textContent = "B";
      select.appendChild(optA);
      select.appendChild(optB);
      wrapper.appendChild(select);

      setupWirer({
        s: ['<input name="Title" value="', '">'],
        "0": "old",
      });

      wirer.wireElements();

      // Both input and select should be wired
      input.value = "new";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      jest.advanceTimersByTime(300);
      expect(sendSpy).toHaveBeenCalledWith({
        action: "change",
        data: { Title: "new" },
      });

      sendSpy.mockClear();

      select.value = "b";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      jest.advanceTimersByTime(300);
      expect(sendSpy).toHaveBeenCalledWith({
        action: "change",
        data: { Category: "b" },
      });
    });

    it("skips select with lvt-change attribute", () => {
      const select = document.createElement("select");
      select.setAttribute("name", "sort_by");
      select.setAttribute("lvt-change", "sort");
      wrapper.appendChild(select);

      wirer.setCapabilities(["change"]);
      wirer.wireElements();

      select.dispatchEvent(new Event("change", { bubbles: true }));
      jest.advanceTimersByTime(300);

      expect(sendSpy).not.toHaveBeenCalled();
    });

    it("skips select with lvt-input attribute", () => {
      const select = document.createElement("select");
      select.setAttribute("name", "sort_by");
      select.setAttribute("lvt-input", "sort");
      wrapper.appendChild(select);

      wirer.setCapabilities(["change"]);
      wirer.wireElements();

      select.dispatchEvent(new Event("change", { bubbles: true }));
      jest.advanceTimersByTime(300);

      expect(sendSpy).not.toHaveBeenCalled();
    });

    it("skips select inside form with lvt-form:no-intercept", () => {
      const form = document.createElement("form");
      form.setAttribute("lvt-form:no-intercept", "");
      const select = document.createElement("select");
      select.setAttribute("name", "sort_by");
      form.appendChild(select);
      wrapper.appendChild(form);

      wirer.setCapabilities(["change"]);
      wirer.wireElements();

      select.dispatchEvent(new Event("change", { bubbles: true }));
      jest.advanceTimersByTime(300);

      expect(sendSpy).not.toHaveBeenCalled();
    });

    it("skips select inside form with lvt-change", () => {
      const form = document.createElement("form");
      form.setAttribute("lvt-change", "change");
      const select = document.createElement("select");
      select.setAttribute("name", "sort_by");
      form.appendChild(select);
      wrapper.appendChild(form);

      wirer.setCapabilities(["change"]);
      wirer.wireElements();

      select.dispatchEvent(new Event("change", { bubbles: true }));
      jest.advanceTimersByTime(300);

      expect(sendSpy).not.toHaveBeenCalled();
    });

    it("does not double-wire select on repeated wireElements calls", () => {
      const select = document.createElement("select");
      select.setAttribute("name", "sort_by");
      const opt = document.createElement("option");
      opt.value = "az";
      select.appendChild(opt);
      wrapper.appendChild(select);

      wirer.setCapabilities(["change"]);

      wirer.wireElements();
      wirer.wireElements();

      select.value = "az";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      jest.advanceTimersByTime(300);

      expect(sendSpy).toHaveBeenCalledTimes(1);
    });

    it("re-wires select after morphdom replacement", () => {
      const select1 = document.createElement("select");
      select1.setAttribute("name", "sort_by");
      const opt1 = document.createElement("option");
      opt1.value = "az";
      select1.appendChild(opt1);
      wrapper.appendChild(select1);

      wirer.setCapabilities(["change"]);
      wirer.wireElements();

      // Simulate morphdom replacing the element
      wrapper.removeChild(select1);
      const select2 = document.createElement("select");
      select2.setAttribute("name", "sort_by");
      const opt2 = document.createElement("option");
      opt2.value = "za";
      select2.appendChild(opt2);
      wrapper.appendChild(select2);

      wirer.wireElements();

      select2.value = "za";
      select2.dispatchEvent(new Event("change", { bubbles: true }));
      jest.advanceTimersByTime(300);

      expect(sendSpy).toHaveBeenCalledWith({
        action: "change",
        data: { sort_by: "za" },
      });
    });

    it("does not wire select when capabilities don't include 'change'", () => {
      const select = document.createElement("select");
      select.setAttribute("name", "sort_by");
      wrapper.appendChild(select);

      wirer.setCapabilities(["other"]);
      wirer.wireElements();

      select.dispatchEvent(new Event("change", { bubbles: true }));
      jest.advanceTimersByTime(300);

      expect(sendSpy).not.toHaveBeenCalled();
    });

    it("does nothing when capabilities don't include 'change'", () => {
      const input = document.createElement("input");
      input.setAttribute("name", "Title");
      wrapper.appendChild(input);

      wirer.setCapabilities(["other"]);
      wirer.analyzeStatics({
        s: ['<input name="Title" value="', '">'],
        "0": "old",
      });

      wirer.wireElements();

      input.value = "new";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      jest.advanceTimersByTime(300);

      expect(sendSpy).not.toHaveBeenCalled();
    });

    it("does not double-wire the same element", () => {
      const input = document.createElement("input");
      input.setAttribute("name", "Title");
      wrapper.appendChild(input);

      setupWirer({
        s: ['<input name="Title" value="', '">'],
        "0": "old",
      });

      // Wire twice
      wirer.wireElements();
      wirer.wireElements();

      input.value = "new";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      jest.advanceTimersByTime(300);

      // Should only send once (not double-wired)
      expect(sendSpy).toHaveBeenCalledTimes(1);
    });

    it("wires new elements after morphdom replaces them", () => {
      const input1 = document.createElement("input");
      input1.setAttribute("name", "Title");
      wrapper.appendChild(input1);

      setupWirer({
        s: ['<input name="Title" value="', '">'],
        "0": "old",
      });

      wirer.wireElements();

      // Simulate morphdom replacing the element (new DOM node)
      wrapper.removeChild(input1);
      const input2 = document.createElement("input");
      input2.setAttribute("name", "Title");
      wrapper.appendChild(input2);

      wirer.wireElements();

      input2.value = "after replace";
      input2.dispatchEvent(new Event("input", { bubbles: true }));
      jest.advanceTimersByTime(300);

      expect(sendSpy).toHaveBeenCalledWith({
        action: "change",
        data: { Title: "after replace" },
      });
    });
  });

  // ===== Teardown =====

  describe("teardown", () => {
    it("removes listeners and resets state", () => {
      const input = document.createElement("input");
      input.setAttribute("name", "Title");
      wrapper.appendChild(input);

      wirer.setCapabilities(["change"]);
      wirer.analyzeStatics({
        s: ['<input name="Title" value="', '">'],
        "0": "old",
      });
      wirer.wireElements();

      // Verify wiring works
      input.value = "test";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      jest.advanceTimersByTime(300);
      expect(sendSpy).toHaveBeenCalledTimes(1);

      sendSpy.mockClear();

      // Teardown
      wirer.teardown();

      // Verify no more sends
      input.value = "after teardown";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      jest.advanceTimersByTime(300);

      expect(sendSpy).not.toHaveBeenCalled();
      expect(wirer.isEnabled()).toBe(false);
      expect(wirer.getBoundFields().size).toBe(0);
    });
  });
});
