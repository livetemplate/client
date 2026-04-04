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
    describe("valid attribute parsing (new lvt-el: pattern)", () => {
      it("parses global lifecycle event", () => {
        const result = parseReactiveAttribute("lvt-el:reset:on:success", "");
        expect(result).toEqual({
          action: "reset",
          lifecycle: "success",
          actionName: undefined,
          param: undefined,
        });
      });

      it("parses action-specific lifecycle event", () => {
        const result = parseReactiveAttribute("lvt-el:reset:on:create-todo:success", "");
        expect(result).toEqual({
          action: "reset",
          lifecycle: "success",
          actionName: "create-todo",
          param: undefined,
        });
      });

      it("parses parameterized action with value", () => {
        const result = parseReactiveAttribute("lvt-el:addclass:on:pending", "loading opacity-50");
        expect(result).toEqual({
          action: "addClass",
          lifecycle: "pending",
          actionName: undefined,
          param: "loading opacity-50",
        });
      });

      it("parses action-specific parameterized action", () => {
        const result = parseReactiveAttribute("lvt-el:addclass:on:save:pending", "loading");
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
          const result = parseReactiveAttribute(`lvt-el:reset:on:${lifecycle}`, "");
          expect(result?.lifecycle).toBe(lifecycle);
        });
      });

      it("parses all method types", () => {
        const methods = [
          ["reset", "reset"],
          ["addclass", "addClass"],
          ["removeclass", "removeClass"],
          ["toggleclass", "toggleClass"],
          ["setattr", "setAttr"],
          ["toggleattr", "toggleAttr"],
        ];
        methods.forEach(([input, expected]) => {
          const result = parseReactiveAttribute(`lvt-el:${input}:on:success`, "value");
          expect(result?.action).toBe(expected);
        });
      });

      it("handles action names with hyphens", () => {
        const result = parseReactiveAttribute("lvt-el:reset:on:create-new-todo:success", "");
        expect(result).toEqual({
          action: "reset",
          lifecycle: "success",
          actionName: "create-new-todo",
          param: undefined,
        });
      });

      it("handles action names with colons", () => {
        const result = parseReactiveAttribute("lvt-el:reset:on:todos:create:success", "");
        expect(result).toEqual({
          action: "reset",
          lifecycle: "success",
          actionName: "todos:create",
          param: undefined,
        });
      });
    });

    describe("click-away interaction keyword", () => {
      it("returns null for click-away (handled by click-away delegation)", () => {
        expect(parseReactiveAttribute("lvt-el:removeclass:on:click-away", "open")).toBeNull();
      });
    });

    describe("invalid attribute parsing", () => {
      it("returns null for non-reactive attributes", () => {
        expect(parseReactiveAttribute("lvt-on:click", "action")).toBeNull();
        expect(parseReactiveAttribute("lvt-on:submit", "save")).toBeNull();
        expect(parseReactiveAttribute("class", "foo")).toBeNull();
      });

      it("returns null for unknown methods", () => {
        expect(parseReactiveAttribute("lvt-el:foo:on:success", "")).toBeNull();
        expect(parseReactiveAttribute("lvt-el:hide:on:pending", "")).toBeNull();
      });

      it("returns null for unknown lifecycle events", () => {
        expect(parseReactiveAttribute("lvt-el:reset:on:loading", "")).toBeNull();
        expect(parseReactiveAttribute("lvt-el:reset:on:complete", "")).toBeNull();
      });

      it("returns null for removed actions (disable/enable)", () => {
        expect(parseReactiveAttribute("lvt-el:disable:on:pending", "")).toBeNull();
        expect(parseReactiveAttribute("lvt-el:enable:on:done", "")).toBeNull();
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

        executeAction(div, "reset");
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
      form.setAttribute("lvt-el:reset:on:success", "");
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
      form.setAttribute("lvt-el:reset:on:create-todo:success", "");
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
      const div = document.createElement("div");
      div.setAttribute("lvt-el:addclass:on:pending", "loading");
      div.setAttribute("lvt-el:setattr:on:pending", "aria-busy:true");
      document.body.appendChild(div);

      processReactiveAttributes("pending", "save");

      expect(div.classList.contains("loading")).toBe(true);
      expect(div.getAttribute("aria-busy")).toBe("true");
    });

    it("processes bindings on multiple elements", () => {
      const form = document.createElement("form");
      form.setAttribute("lvt-el:reset:on:success", "");
      const input = document.createElement("input");
      input.value = "test";
      form.appendChild(input);

      const div = document.createElement("div");
      div.setAttribute("lvt-el:removeclass:on:success", "loading");
      div.className = "loading";

      document.body.appendChild(form);
      document.body.appendChild(div);

      processReactiveAttributes("success", "save");

      expect(input.value).toBe("");
      expect(div.classList.contains("loading")).toBe(false);
    });

    it("ignores bindings for different lifecycles", () => {
      const div = document.createElement("div");
      div.setAttribute("lvt-el:addclass:on:pending", "loading");
      document.body.appendChild(div);

      processReactiveAttributes("success", "save");

      expect(div.classList.contains("loading")).toBe(false);
    });
  });

  describe("setupReactiveAttributeListeners", () => {
    it("sets up listeners for all lifecycle events", () => {
      setupReactiveAttributeListeners();

      const div = document.createElement("div");
      div.setAttribute("lvt-el:addclass:on:pending", "loading");
      div.setAttribute("lvt-el:removeclass:on:done", "loading");
      document.body.appendChild(div);

      // Simulate pending event
      document.dispatchEvent(
        new CustomEvent("lvt:pending", {
          detail: { action: "save" },
          bubbles: true,
        })
      );
      expect(div.classList.contains("loading")).toBe(true);

      // Simulate done event
      document.dispatchEvent(
        new CustomEvent("lvt:done", {
          detail: { action: "save" },
          bubbles: true,
        })
      );
      expect(div.classList.contains("loading")).toBe(false);
    });

    it("handles events without action name", () => {
      setupReactiveAttributeListeners();

      const div = document.createElement("div");
      div.setAttribute("lvt-el:addclass:on:success", "success-state");
      document.body.appendChild(div);

      document.dispatchEvent(
        new CustomEvent("lvt:success", {
          detail: {},
          bubbles: true,
        })
      );

      expect(div.classList.contains("success-state")).toBe(true);
    });
  });
});
