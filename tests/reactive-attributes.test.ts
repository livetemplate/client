import {
  parseReactiveAttribute,
  executeAction,
  matchesEvent,
  processReactiveAttributes,
  setupReactiveAttributeListeners,
  type ReactiveBinding,
  type LifecycleEvent,
} from "../dom/reactive-attributes";

describe("Reactive Attributes", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  describe("parseReactiveAttribute", () => {
    describe("valid attribute parsing", () => {
      it("parses global lifecycle event", () => {
        const result = parseReactiveAttribute("lvt-reset-on:success", "");
        expect(result).toEqual({
          action: "reset",
          lifecycle: "success",
          actionName: undefined,
          param: undefined,
        });
      });

      it("parses action-specific lifecycle event", () => {
        const result = parseReactiveAttribute("lvt-reset-on:create-todo:success", "");
        expect(result).toEqual({
          action: "reset",
          lifecycle: "success",
          actionName: "create-todo",
          param: undefined,
        });
      });

      it("parses parameterized action with value", () => {
        const result = parseReactiveAttribute("lvt-addClass-on:pending", "loading opacity-50");
        expect(result).toEqual({
          action: "addClass",
          lifecycle: "pending",
          actionName: undefined,
          param: "loading opacity-50",
        });
      });

      it("parses action-specific parameterized action", () => {
        const result = parseReactiveAttribute("lvt-addClass-on:save:pending", "loading");
        expect(result).toEqual({
          action: "addClass",
          lifecycle: "pending",
          actionName: "save",
          param: "loading",
        });
      });

      it("parses all lifecycle events", () => {
        const lifecycles: LifecycleEvent[] = ["pending", "success", "error", "done"];
        lifecycles.forEach((lifecycle) => {
          const result = parseReactiveAttribute(`lvt-reset-on:${lifecycle}`, "");
          expect(result?.lifecycle).toBe(lifecycle);
        });
      });

      it("parses all action types", () => {
        const actions = [
          "reset",
          "disable",
          "enable",
          "addClass",
          "removeClass",
          "toggleClass",
          "setAttr",
          "toggleAttr",
        ];
        actions.forEach((action) => {
          const result = parseReactiveAttribute(`lvt-${action}-on:success`, "value");
          expect(result?.action).toBe(action);
        });
      });

      it("handles action names with hyphens", () => {
        const result = parseReactiveAttribute("lvt-reset-on:create-new-todo:success", "");
        expect(result).toEqual({
          action: "reset",
          lifecycle: "success",
          actionName: "create-new-todo",
          param: undefined,
        });
      });

      it("handles action names with colons", () => {
        const result = parseReactiveAttribute("lvt-reset-on:todos:create:success", "");
        expect(result).toEqual({
          action: "reset",
          lifecycle: "success",
          actionName: "todos:create",
          param: undefined,
        });
      });
    });

    describe("invalid attribute parsing", () => {
      it("returns null for non-reactive attributes", () => {
        expect(parseReactiveAttribute("lvt-click", "action")).toBeNull();
        expect(parseReactiveAttribute("lvt-submit", "save")).toBeNull();
        expect(parseReactiveAttribute("class", "foo")).toBeNull();
      });

      it("returns null for unknown actions", () => {
        expect(parseReactiveAttribute("lvt-foo-on:success", "")).toBeNull();
        expect(parseReactiveAttribute("lvt-hide-on:pending", "")).toBeNull();
      });

      it("returns null for unknown lifecycle events", () => {
        expect(parseReactiveAttribute("lvt-reset-on:loading", "")).toBeNull();
        expect(parseReactiveAttribute("lvt-reset-on:complete", "")).toBeNull();
      });
    });
  });

  describe("executeAction", () => {
    describe("reset", () => {
      it("resets a form", () => {
        const form = document.createElement("form");
        const input = document.createElement("input");
        input.name = "title";
        input.value = "test value";
        form.appendChild(input);
        document.body.appendChild(form);

        executeAction(form, "reset");

        expect(input.value).toBe("");
      });

      it("does nothing for non-form elements", () => {
        const div = document.createElement("div");
        document.body.appendChild(div);

        // Should not throw
        executeAction(div, "reset");
      });
    });

    describe("disable/enable", () => {
      it("disables a button", () => {
        const button = document.createElement("button");
        document.body.appendChild(button);

        executeAction(button, "disable");
        expect(button.disabled).toBe(true);
      });

      it("enables a button", () => {
        const button = document.createElement("button");
        button.disabled = true;
        document.body.appendChild(button);

        executeAction(button, "enable");
        expect(button.disabled).toBe(false);
      });

      it("disables an input", () => {
        const input = document.createElement("input");
        document.body.appendChild(input);

        executeAction(input, "disable");
        expect(input.disabled).toBe(true);
      });

      it("enables an input", () => {
        const input = document.createElement("input");
        input.disabled = true;
        document.body.appendChild(input);

        executeAction(input, "enable");
        expect(input.disabled).toBe(false);
      });
    });

    describe("addClass", () => {
      it("adds a single class", () => {
        const div = document.createElement("div");
        document.body.appendChild(div);

        executeAction(div, "addClass", "loading");
        expect(div.classList.contains("loading")).toBe(true);
      });

      it("adds multiple classes", () => {
        const div = document.createElement("div");
        document.body.appendChild(div);

        executeAction(div, "addClass", "loading opacity-50 cursor-wait");
        expect(div.classList.contains("loading")).toBe(true);
        expect(div.classList.contains("opacity-50")).toBe(true);
        expect(div.classList.contains("cursor-wait")).toBe(true);
      });

      it("does nothing without param", () => {
        const div = document.createElement("div");
        document.body.appendChild(div);

        executeAction(div, "addClass");
        expect(div.className).toBe("");
      });
    });

    describe("removeClass", () => {
      it("removes a single class", () => {
        const div = document.createElement("div");
        div.className = "loading active";
        document.body.appendChild(div);

        executeAction(div, "removeClass", "loading");
        expect(div.classList.contains("loading")).toBe(false);
        expect(div.classList.contains("active")).toBe(true);
      });

      it("removes multiple classes", () => {
        const div = document.createElement("div");
        div.className = "loading opacity-50 active";
        document.body.appendChild(div);

        executeAction(div, "removeClass", "loading opacity-50");
        expect(div.classList.contains("loading")).toBe(false);
        expect(div.classList.contains("opacity-50")).toBe(false);
        expect(div.classList.contains("active")).toBe(true);
      });
    });

    describe("toggleClass", () => {
      it("toggles class on", () => {
        const div = document.createElement("div");
        document.body.appendChild(div);

        executeAction(div, "toggleClass", "active");
        expect(div.classList.contains("active")).toBe(true);
      });

      it("toggles class off", () => {
        const div = document.createElement("div");
        div.className = "active";
        document.body.appendChild(div);

        executeAction(div, "toggleClass", "active");
        expect(div.classList.contains("active")).toBe(false);
      });

      it("toggles multiple classes", () => {
        const div = document.createElement("div");
        div.className = "active";
        document.body.appendChild(div);

        executeAction(div, "toggleClass", "active hidden");
        expect(div.classList.contains("active")).toBe(false);
        expect(div.classList.contains("hidden")).toBe(true);
      });
    });

    describe("setAttr", () => {
      it("sets an attribute", () => {
        const div = document.createElement("div");
        document.body.appendChild(div);

        executeAction(div, "setAttr", "aria-busy:true");
        expect(div.getAttribute("aria-busy")).toBe("true");
      });

      it("sets attribute with empty value", () => {
        const div = document.createElement("div");
        document.body.appendChild(div);

        executeAction(div, "setAttr", "data-loading:");
        expect(div.getAttribute("data-loading")).toBe("");
      });

      it("handles value with colons", () => {
        const div = document.createElement("div");
        document.body.appendChild(div);

        executeAction(div, "setAttr", "data-url:https://example.com");
        expect(div.getAttribute("data-url")).toBe("https://example.com");
      });

      it("does nothing without colon separator", () => {
        const div = document.createElement("div");
        document.body.appendChild(div);

        executeAction(div, "setAttr", "invalidformat");
        expect(div.attributes.length).toBe(0);
      });
    });

    describe("toggleAttr", () => {
      it("adds boolean attribute", () => {
        const input = document.createElement("input");
        document.body.appendChild(input);

        executeAction(input, "toggleAttr", "readonly");
        expect(input.hasAttribute("readonly")).toBe(true);
      });

      it("removes boolean attribute", () => {
        const input = document.createElement("input");
        input.setAttribute("readonly", "");
        document.body.appendChild(input);

        executeAction(input, "toggleAttr", "readonly");
        expect(input.hasAttribute("readonly")).toBe(false);
      });

      it("toggles hidden attribute", () => {
        const div = document.createElement("div");
        div.hidden = true;
        document.body.appendChild(div);

        executeAction(div, "toggleAttr", "hidden");
        expect(div.hidden).toBe(false);

        executeAction(div, "toggleAttr", "hidden");
        expect(div.hidden).toBe(true);
      });
    });
  });

  describe("matchesEvent", () => {
    it("matches global binding to any action", () => {
      const binding: ReactiveBinding = {
        action: "reset",
        lifecycle: "success",
      };

      expect(matchesEvent(binding, "success", "create-todo")).toBe(true);
      expect(matchesEvent(binding, "success", "delete-todo")).toBe(true);
      expect(matchesEvent(binding, "success")).toBe(true);
    });

    it("matches action-specific binding only to that action", () => {
      const binding: ReactiveBinding = {
        action: "reset",
        lifecycle: "success",
        actionName: "create-todo",
      };

      expect(matchesEvent(binding, "success", "create-todo")).toBe(true);
      expect(matchesEvent(binding, "success", "delete-todo")).toBe(false);
      expect(matchesEvent(binding, "success")).toBe(false);
    });

    it("does not match different lifecycle events", () => {
      const binding: ReactiveBinding = {
        action: "reset",
        lifecycle: "success",
      };

      expect(matchesEvent(binding, "pending", "create-todo")).toBe(false);
      expect(matchesEvent(binding, "error", "create-todo")).toBe(false);
      expect(matchesEvent(binding, "done", "create-todo")).toBe(false);
    });
  });

  describe("processReactiveAttributes", () => {
    it("processes global success bindings", () => {
      const form = document.createElement("form");
      form.setAttribute("lvt-reset-on:success", "");
      const input = document.createElement("input");
      input.name = "title";
      input.value = "test";
      form.appendChild(input);
      document.body.appendChild(form);

      processReactiveAttributes("success", "any-action");

      expect(input.value).toBe("");
    });

    it("processes action-specific bindings", () => {
      const form = document.createElement("form");
      form.setAttribute("lvt-reset-on:create-todo:success", "");
      const input = document.createElement("input");
      input.name = "title";
      input.value = "test";
      form.appendChild(input);
      document.body.appendChild(form);

      // Should not reset for different action
      processReactiveAttributes("success", "delete-todo");
      expect(input.value).toBe("test");

      // Should reset for matching action
      processReactiveAttributes("success", "create-todo");
      expect(input.value).toBe("");
    });

    it("processes multiple bindings on same element", () => {
      const button = document.createElement("button");
      button.setAttribute("lvt-disable-on:pending", "");
      button.setAttribute("lvt-addClass-on:pending", "loading");
      document.body.appendChild(button);

      processReactiveAttributes("pending", "save");

      expect(button.disabled).toBe(true);
      expect(button.classList.contains("loading")).toBe(true);
    });

    it("processes bindings on multiple elements", () => {
      const form = document.createElement("form");
      form.setAttribute("lvt-reset-on:success", "");
      const input = document.createElement("input");
      input.value = "test";
      form.appendChild(input);

      const button = document.createElement("button");
      button.disabled = true;
      button.setAttribute("lvt-enable-on:success", "");

      document.body.appendChild(form);
      document.body.appendChild(button);

      processReactiveAttributes("success", "save");

      expect(input.value).toBe("");
      expect(button.disabled).toBe(false);
    });

    it("ignores bindings for different lifecycles", () => {
      const button = document.createElement("button");
      button.setAttribute("lvt-disable-on:pending", "");
      document.body.appendChild(button);

      processReactiveAttributes("success", "save");

      expect(button.disabled).toBe(false);
    });
  });

  describe("setupReactiveAttributeListeners", () => {
    it("sets up listeners for all lifecycle events", () => {
      setupReactiveAttributeListeners();

      const button = document.createElement("button");
      button.setAttribute("lvt-disable-on:pending", "");
      button.setAttribute("lvt-enable-on:done", "");
      document.body.appendChild(button);

      // Simulate pending event
      document.dispatchEvent(
        new CustomEvent("lvt:pending", {
          detail: { action: "save" },
          bubbles: true,
        })
      );
      expect(button.disabled).toBe(true);

      // Simulate done event
      document.dispatchEvent(
        new CustomEvent("lvt:done", {
          detail: { action: "save" },
          bubbles: true,
        })
      );
      expect(button.disabled).toBe(false);
    });

    it("handles events without action name", () => {
      setupReactiveAttributeListeners();

      const div = document.createElement("div");
      div.setAttribute("lvt-addClass-on:success", "success-state");
      document.body.appendChild(div);

      // Event without action in detail
      document.dispatchEvent(
        new CustomEvent("lvt:success", {
          detail: {},
          bubbles: true,
        })
      );

      // Global binding should still work
      expect(div.classList.contains("success-state")).toBe(true);
    });
  });
});
