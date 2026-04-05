import {
  parseReactiveAttribute,
  executeAction,
  resolveTarget,
  matchesEvent,
  processReactiveAttributes,
  setupReactiveAttributeListeners,
  processElementInteraction,
  isDOMEventTrigger,
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

    describe("interaction triggers (non-lifecycle)", () => {
      it("returns null for click-away (handled by click-away delegation)", () => {
        expect(parseReactiveAttribute("lvt-el:removeclass:on:click-away", "open")).toBeNull();
      });

      it("returns null for native DOM event triggers (handled by DOM event delegation)", () => {
        expect(parseReactiveAttribute("lvt-el:toggleclass:on:click", "open")).toBeNull();
        expect(parseReactiveAttribute("lvt-el:addclass:on:focusin", "open")).toBeNull();
        expect(parseReactiveAttribute("lvt-el:removeclass:on:focusout", "open")).toBeNull();
        expect(parseReactiveAttribute("lvt-el:addclass:on:mouseenter", "visible")).toBeNull();
        expect(parseReactiveAttribute("lvt-el:removeclass:on:mouseleave", "visible")).toBeNull();
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

  describe("isDOMEventTrigger", () => {
    it("returns false for lifecycle states", () => {
      expect(isDOMEventTrigger("pending")).toBe(false);
      expect(isDOMEventTrigger("success")).toBe(false);
      expect(isDOMEventTrigger("error")).toBe(false);
      expect(isDOMEventTrigger("done")).toBe(false);
    });

    it("returns false for synthetic triggers", () => {
      expect(isDOMEventTrigger("click-away")).toBe(false);
    });

    it("returns true for native DOM events", () => {
      expect(isDOMEventTrigger("click")).toBe(true);
      expect(isDOMEventTrigger("focusin")).toBe(true);
      expect(isDOMEventTrigger("focusout")).toBe(true);
      expect(isDOMEventTrigger("mouseenter")).toBe(true);
      expect(isDOMEventTrigger("mouseleave")).toBe(true);
      expect(isDOMEventTrigger("keydown")).toBe(true);
      expect(isDOMEventTrigger("input")).toBe(true);
    });
  });

  describe("processElementInteraction", () => {
    it("adds class on matching trigger", () => {
      const div = document.createElement("div");
      div.setAttribute("lvt-el:addClass:on:click", "open");
      document.body.appendChild(div);

      processElementInteraction(div, "click");
      expect(div.classList.contains("open")).toBe(true);
    });

    it("removes class on matching trigger", () => {
      const div = document.createElement("div");
      div.classList.add("open");
      div.setAttribute("lvt-el:removeClass:on:focusout", "open");
      document.body.appendChild(div);

      processElementInteraction(div, "focusout");
      expect(div.classList.contains("open")).toBe(false);
    });

    it("toggles class on matching trigger", () => {
      const div = document.createElement("div");
      div.setAttribute("lvt-el:toggleClass:on:click", "open");
      document.body.appendChild(div);

      processElementInteraction(div, "click");
      expect(div.classList.contains("open")).toBe(true);
      processElementInteraction(div, "click");
      expect(div.classList.contains("open")).toBe(false);
    });

    it("ignores non-matching trigger", () => {
      const div = document.createElement("div");
      div.setAttribute("lvt-el:addClass:on:click", "open");
      document.body.appendChild(div);

      processElementInteraction(div, "mouseenter");
      expect(div.classList.contains("open")).toBe(false);
    });

    it("handles multiple triggers on same element", () => {
      const div = document.createElement("div");
      div.setAttribute("lvt-el:addClass:on:mouseenter", "visible");
      div.setAttribute("lvt-el:removeClass:on:mouseleave", "visible");
      document.body.appendChild(div);

      processElementInteraction(div, "mouseenter");
      expect(div.classList.contains("visible")).toBe(true);

      processElementInteraction(div, "mouseleave");
      expect(div.classList.contains("visible")).toBe(false);
    });
  });

  describe("data-lvt-target", () => {
    it("resolves #id to document.getElementById", () => {
      const target = document.createElement("div");
      target.id = "my-target";
      document.body.appendChild(target);

      const button = document.createElement("button");
      button.setAttribute("data-lvt-target", "#my-target");
      document.body.appendChild(button);

      expect(resolveTarget(button)).toBe(target);

      target.remove();
      button.remove();
    });

    it("resolves closest:selector to element.closest", () => {
      const parent = document.createElement("div");
      parent.setAttribute("data-dropdown", "test");
      const button = document.createElement("button");
      button.setAttribute("data-lvt-target", "closest:[data-dropdown]");
      parent.appendChild(button);
      document.body.appendChild(parent);

      expect(resolveTarget(button)).toBe(parent);

      parent.remove();
    });

    it("falls back to self when no data-lvt-target", () => {
      const button = document.createElement("button");
      document.body.appendChild(button);

      expect(resolveTarget(button)).toBe(button);

      button.remove();
    });

    it("falls back to self when target not found", () => {
      const button = document.createElement("button");
      button.setAttribute("data-lvt-target", "#nonexistent");
      document.body.appendChild(button);

      expect(resolveTarget(button)).toBe(button);

      button.remove();
    });

    it("processElementInteraction targets resolved element", () => {
      const target = document.createElement("div");
      target.id = "modal";
      target.setAttribute("hidden", "");
      document.body.appendChild(target);

      const button = document.createElement("button");
      button.setAttribute("lvt-el:toggleAttr:on:click", "hidden");
      button.setAttribute("data-lvt-target", "#modal");
      document.body.appendChild(button);

      processElementInteraction(button, "click");
      expect(target.hasAttribute("hidden")).toBe(false);

      processElementInteraction(button, "click");
      expect(target.hasAttribute("hidden")).toBe(true);

      target.remove();
      button.remove();
    });

    it("toggleClass on closest ancestor", () => {
      const parent = document.createElement("div");
      parent.setAttribute("data-dropdown", "test");
      const button = document.createElement("button");
      button.setAttribute("lvt-el:toggleClass:on:click", "open");
      button.setAttribute("data-lvt-target", "closest:[data-dropdown]");
      parent.appendChild(button);
      document.body.appendChild(parent);

      processElementInteraction(button, "click");
      expect(parent.classList.contains("open")).toBe(true);

      processElementInteraction(button, "click");
      expect(parent.classList.contains("open")).toBe(false);

      parent.remove();
    });
  });
});
