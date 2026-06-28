import {
  EventDelegator,
  EventDelegationContext,
  keyFilterMatches,
} from "../dom/event-delegation";
import { createLogger } from "../utils/logger";

describe("EventDelegator", () => {
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    document.body.innerHTML = "";
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    jest.useRealTimers();
    document.body.innerHTML = "";
  });

  const createContext = (
    wrapper: Element,
    overrides: Partial<EventDelegationContext> = {}
  ) => {
    const rateLimitedHandlers = new WeakMap<Element, Map<string, Function>>();

    const baseContext: EventDelegationContext = {
      getWrapperElement: () => wrapper,
      getRateLimitedHandlers: () => rateLimitedHandlers,
      parseValue: (value: string) => value,
      send: jest.fn(),
      sendHTTPMultipart: jest.fn(),
      setActiveSubmission: jest.fn(),
      getWebSocketReadyState: () => 1,
      triggerPendingUploads: jest.fn(),
    };

    return { ...baseContext, ...overrides } as EventDelegationContext & {
      send: jest.Mock;
      setActiveSubmission: jest.Mock;
    };
  };

  it("sends action payloads for delegated click events", () => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-lvt-id", "wrapper-1");
    wrapper.innerHTML = `
      <button id="save" lvt-on:click="save" data-id="42"></button>
    `;
    document.body.appendChild(wrapper);

    const context = createContext(wrapper);
    const delegator = new EventDelegator(
      context,
      createLogger({ scope: "EventDelegatorTest", level: "silent" })
    );
    delegator.setupEventDelegation();

    const button = document.getElementById("save")!;
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(context.send).toHaveBeenCalledTimes(1);
    expect(context.send).toHaveBeenCalledWith({
      action: "save",
      data: { id: "42" },
    });
  });

  it("applies throttle semantics for rate limited handlers", () => {
    jest.useFakeTimers();

    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-lvt-id", "wrapper-2");
    wrapper.innerHTML = `
      <button id="ping" lvt-on:click="ping" lvt-mod:throttle="200"></button>
    `;
    document.body.appendChild(wrapper);

    const context = createContext(wrapper);
    const delegator = new EventDelegator(
      context,
      createLogger({ scope: "EventDelegatorTest", level: "silent" })
    );
    delegator.setupEventDelegation();

    const button = document.getElementById("ping")!;
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(context.send).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(200);
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(context.send).toHaveBeenCalledTimes(2);
  });

  it("preserves password field values as strings (not parsed to numbers)", () => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-lvt-id", "wrapper-password");
    wrapper.innerHTML = `
      <form id="login-form" lvt-on:submit="login">
        <input type="text" name="username" value="testuser" />
        <input type="password" name="password" value="12345" />
        <button type="submit" id="submit">Login</button>
      </form>
    `;
    document.body.appendChild(wrapper);

    const form = document.getElementById("login-form") as HTMLFormElement;
    const submitButton = document.getElementById("submit") as HTMLButtonElement;

    // Use a parseValue that would convert "12345" to number
    const context = createContext(wrapper, {
      parseValue: (value: string) => {
        const num = Number(value);
        return !isNaN(num) && value.trim() !== "" ? num : value;
      },
    });
    const delegator = new EventDelegator(
      context,
      createLogger({ scope: "EventDelegatorTest", level: "silent" })
    );
    delegator.setupEventDelegation();

    const submitEvent = new Event("submit", {
      bubbles: true,
      cancelable: true,
    }) as SubmitEvent & { submitter?: HTMLButtonElement };
    submitEvent.submitter = submitButton;

    form.dispatchEvent(submitEvent);

    expect(context.send).toHaveBeenCalledTimes(1);
    expect(context.send).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "login",
        data: expect.objectContaining({
          username: "testuser",
          password: "12345", // Should remain a string, not converted to 12345 (number)
        }),
      })
    );

    // Verify password is specifically a string type
    const sentData = context.send.mock.calls[0][0].data;
    expect(typeof sentData.password).toBe("string");
  });

  it("handles form submissions and records active submission state", () => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-lvt-id", "wrapper-3");
    wrapper.innerHTML = `
      <form id="add-form" lvt-on:submit="add">
        <input type="text" name="title" value="Hello" />
        <input type="checkbox" name="published" checked />
        <button type="submit" id="submit" lvt-form:disable-with="Saving...">Save</button>
      </form>
    `;
    document.body.appendChild(wrapper);

    const form = document.getElementById("add-form") as HTMLFormElement;
    const submitButton = document.getElementById("submit") as HTMLButtonElement;

    const context = createContext(wrapper);
    const delegator = new EventDelegator(
      context,
      createLogger({ scope: "EventDelegatorTest", level: "silent" })
    );
    delegator.setupEventDelegation();

    const submitEvent = new Event("submit", {
      bubbles: true,
      cancelable: true,
    }) as SubmitEvent & { submitter?: HTMLButtonElement };
    submitEvent.submitter = submitButton;

    form.dispatchEvent(submitEvent);

    expect(context.setActiveSubmission).toHaveBeenCalledWith(
      form,
      submitButton,
      "Save"
    );

    expect(submitButton.disabled).toBe(true);
    expect(submitButton.textContent).toBe("Saving...");

    expect(context.send).toHaveBeenCalledTimes(1);
    expect(context.send).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "add",
        data: expect.objectContaining({
          title: "Hello",
          published: true,
        }),
      })
    );
  });

  it("sends array of values for multiple same-name checkboxes", () => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-lvt-id", "wrapper-multi-checkbox");
    wrapper.innerHTML = `
      <form id="multi-cb-form" lvt-on:submit="process">
        <input type="checkbox" name="ids" value="a" checked />
        <input type="checkbox" name="ids" value="b" />
        <input type="checkbox" name="ids" value="c" checked />
        <input type="checkbox" name="solo" checked />
        <button type="submit" id="multi-cb-submit">Go</button>
      </form>
    `;
    document.body.appendChild(wrapper);

    const form = document.getElementById("multi-cb-form") as HTMLFormElement;
    const submitButton = document.getElementById("multi-cb-submit") as HTMLButtonElement;

    const context = createContext(wrapper);
    const delegator = new EventDelegator(
      context,
      createLogger({ scope: "EventDelegatorTest", level: "silent" })
    );
    delegator.setupEventDelegation();

    const submitEvent = new Event("submit", {
      bubbles: true,
      cancelable: true,
    }) as SubmitEvent & { submitter?: HTMLButtonElement };
    submitEvent.submitter = submitButton;

    form.dispatchEvent(submitEvent);

    expect(context.send).toHaveBeenCalledTimes(1);
    const sentData = context.send.mock.calls[0][0].data;
    expect(sentData.ids).toEqual(["a", "c"]);
    expect(sentData.solo).toBe(true);
  });

  it("sends empty array when no checkboxes are checked in multi-group", () => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-lvt-id", "wrapper-multi-cb-none");
    wrapper.innerHTML = `
      <form id="multi-cb-none-form" lvt-on:submit="process">
        <input type="checkbox" name="ids" value="a" />
        <input type="checkbox" name="ids" value="b" />
        <button type="submit" id="multi-cb-none-submit">Go</button>
      </form>
    `;
    document.body.appendChild(wrapper);

    const form = document.getElementById("multi-cb-none-form") as HTMLFormElement;
    const submitButton = document.getElementById("multi-cb-none-submit") as HTMLButtonElement;

    const context = createContext(wrapper);
    const delegator = new EventDelegator(
      context,
      createLogger({ scope: "EventDelegatorTest", level: "silent" })
    );
    delegator.setupEventDelegation();

    const submitEvent = new Event("submit", {
      bubbles: true,
      cancelable: true,
    }) as SubmitEvent & { submitter?: HTMLButtonElement };
    submitEvent.submitter = submitButton;

    form.dispatchEvent(submitEvent);

    expect(context.send).toHaveBeenCalledTimes(1);
    const sentData = context.send.mock.calls[0][0].data;
    expect(sentData.ids).toEqual([]);
  });

  it("ignores hidden inputs sharing a checkbox name", () => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-lvt-id", "wrapper-hidden-cb");
    const formHtml = [
      '<form id="hidden-cb-form" lvt-on:submit="save">',
      '  <input type="hidden" name="agree" value="0" />',
      '  <input type="checkbox" name="agree" checked />',
      '  <button type="submit" id="hidden-cb-submit">Go</button>',
      '</form>',
    ].join("\n");
    wrapper.innerHTML = formHtml; // Safe: hardcoded test markup
    document.body.appendChild(wrapper);

    const form = document.getElementById("hidden-cb-form") as HTMLFormElement;
    const submitButton = document.getElementById("hidden-cb-submit") as HTMLButtonElement;

    const context = createContext(wrapper);
    const delegator = new EventDelegator(
      context,
      createLogger({ scope: "EventDelegatorTest", level: "silent" })
    );
    delegator.setupEventDelegation();

    const submitEvent = new Event("submit", {
      bubbles: true,
      cancelable: true,
    }) as SubmitEvent & { submitter?: HTMLButtonElement };
    submitEvent.submitter = submitButton;

    form.dispatchEvent(submitEvent);

    expect(context.send).toHaveBeenCalledTimes(1);
    const sentData = context.send.mock.calls[0][0].data;
    expect(sentData.agree).toBe(true);
  });

  it("sends singleton array when one checkbox is checked in multi-group", () => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-lvt-id", "wrapper-singleton-cb");
    const formHtml = [
      '<form id="singleton-cb-form" lvt-on:submit="process">',
      '  <input type="checkbox" name="ids" value="a" checked />',
      '  <input type="checkbox" name="ids" value="b" />',
      '  <input type="checkbox" name="ids" value="c" />',
      '  <button type="submit" id="singleton-cb-submit">Go</button>',
      '</form>',
    ].join("\n");
    wrapper.innerHTML = formHtml; // Safe: hardcoded test markup
    document.body.appendChild(wrapper);

    const form = document.getElementById("singleton-cb-form") as HTMLFormElement;
    const submitButton = document.getElementById("singleton-cb-submit") as HTMLButtonElement;

    const context = createContext(wrapper);
    const delegator = new EventDelegator(
      context,
      createLogger({ scope: "EventDelegatorTest", level: "silent" })
    );
    delegator.setupEventDelegation();

    const submitEvent = new Event("submit", {
      bubbles: true,
      cancelable: true,
    }) as SubmitEvent & { submitter?: HTMLButtonElement };
    submitEvent.submitter = submitButton;

    form.dispatchEvent(submitEvent);

    expect(context.send).toHaveBeenCalledTimes(1);
    const sentData = context.send.mock.calls[0][0].data;
    expect(sentData.ids).toEqual(["a"]);
  });

  it("lvt-form:action attribute takes priority over button name", () => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-lvt-id", "wrapper-form-action");
    wrapper.innerHTML = `
      <form id="action-form" lvt-form:action="checkout">
        <input type="text" name="item" value="widget" />
        <button type="submit" id="submit" name="save">Save</button>
      </form>
    `;
    document.body.appendChild(wrapper);

    const form = document.getElementById("action-form") as HTMLFormElement;
    const submitButton = document.getElementById("submit") as HTMLButtonElement;

    const context = createContext(wrapper);
    const delegator = new EventDelegator(
      context,
      createLogger({ scope: "EventDelegatorTest", level: "silent" })
    );
    delegator.setupEventDelegation();

    const submitEvent = new Event("submit", {
      bubbles: true,
      cancelable: true,
    }) as SubmitEvent & { submitter?: HTMLButtonElement };
    submitEvent.submitter = submitButton;

    form.dispatchEvent(submitEvent);

    expect(context.send).toHaveBeenCalledTimes(1);
    // lvt-form:action="checkout" takes priority over button name="save"
    expect(context.send).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "checkout",
        data: expect.objectContaining({ item: "widget" }),
      })
    );
  });

  it("action field in form data is preserved as normal data", () => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-lvt-id", "wrapper-action-data");
    wrapper.innerHTML = `
      <form id="workflow-form" lvt-form:action="processStep">
        <input type="hidden" name="action" value="approve" />
        <input type="text" name="reason" value="looks good" />
        <button type="submit" id="submit">Submit</button>
      </form>
    `;
    document.body.appendChild(wrapper);

    const form = document.getElementById("workflow-form") as HTMLFormElement;
    const submitButton = document.getElementById("submit") as HTMLButtonElement;

    const context = createContext(wrapper);
    const delegator = new EventDelegator(
      context,
      createLogger({ scope: "EventDelegatorTest", level: "silent" })
    );
    delegator.setupEventDelegation();

    const submitEvent = new Event("submit", {
      bubbles: true,
      cancelable: true,
    }) as SubmitEvent & { submitter?: HTMLButtonElement };
    submitEvent.submitter = submitButton;

    form.dispatchEvent(submitEvent);

    expect(context.send).toHaveBeenCalledTimes(1);
    expect(context.send).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "processStep",
        data: expect.objectContaining({
          action: "approve", // "action" is NOT reserved — it flows through as data
          reason: "looks good",
        }),
      })
    );
  });

  describe("focus trap", () => {
    it("sets up keydown listener for focus trap", () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-focus-trap");
      wrapper.innerHTML = `
        <div id="modal" lvt-focus-trap>
          <button id="first">First</button>
          <button id="last">Last</button>
        </div>
      `;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupFocusTrapDelegation();

      // Verify listener was registered
      const listenerKey = `__lvt_focus_trap_wrapper-focus-trap`;
      expect((document as any)[listenerKey]).toBeDefined();
    });

    it("prevents default on Tab at boundary and cycles focus", () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-focus-trap-cycle");
      wrapper.innerHTML = `
        <div id="modal" lvt-focus-trap>
          <button id="first">First</button>
          <button id="last">Last</button>
        </div>
      `;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupFocusTrapDelegation();

      const firstButton = document.getElementById("first") as HTMLElement;
      const lastButton = document.getElementById("last") as HTMLElement;

      // Focus the last element
      lastButton.focus();

      // Create a Tab event that can be prevented
      const tabEvent = new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      });

      // Spy on preventDefault
      const preventDefaultSpy = jest.spyOn(tabEvent, "preventDefault");

      document.dispatchEvent(tabEvent);

      // In JSDOM, the event should trigger our handler which calls preventDefault and focus
      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(document.activeElement).toBe(firstButton);
    });

    it("prevents default on Shift+Tab at boundary and cycles focus backwards", () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-focus-trap-shift");
      wrapper.innerHTML = `
        <div id="modal" lvt-focus-trap>
          <button id="first">First</button>
          <button id="last">Last</button>
        </div>
      `;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupFocusTrapDelegation();

      const firstButton = document.getElementById("first") as HTMLElement;
      const lastButton = document.getElementById("last") as HTMLElement;

      // Focus the first element
      firstButton.focus();

      // Create a Shift+Tab event
      const shiftTabEvent = new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });

      const preventDefaultSpy = jest.spyOn(shiftTabEvent, "preventDefault");

      document.dispatchEvent(shiftTabEvent);

      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(document.activeElement).toBe(lastButton);
    });
  });

  describe("autofocus", () => {
    it("marks element with lvt-autofocus for focusing", () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-autofocus");
      wrapper.innerHTML = `
        <input id="search" type="text" lvt-autofocus />
      `;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupAutofocusDelegation();

      // The element should be marked for autofocus (actual focus happens in RAF)
      const input = document.getElementById("search") as HTMLInputElement;
      expect(input.getAttribute("data-lvt-autofocused")).toBe("true");
    });

    it("sets up mutation observer for autofocus elements", () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-autofocus-observer");
      wrapper.innerHTML = `
        <div id="container"></div>
      `;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupAutofocusDelegation();

      // Verify observer is attached
      const observerKey = `__lvt_autofocus_observer_wrapper-autofocus-observer`;
      expect((wrapper as any)[observerKey]).toBeDefined();
    });

    it("does not mark hidden elements for autofocus", () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-autofocus-hidden");
      wrapper.innerHTML = `
        <input id="hidden-search" type="text" lvt-autofocus style="display: none" />
      `;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupAutofocusDelegation();

      // Hidden element should not be marked for autofocus
      const input = document.getElementById("hidden-search") as HTMLInputElement;
      expect(input.getAttribute("data-lvt-autofocused")).toBeNull();
    });

    it("marks element for autofocus when it becomes visible", async () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-autofocus-toggle");
      wrapper.innerHTML = `
        <input id="toggle-input" type="text" lvt-autofocus style="display: none" />
      `;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupAutofocusDelegation();

      const input = document.getElementById("toggle-input") as HTMLInputElement;

      // Initially hidden, should not be marked
      expect(input.getAttribute("data-lvt-autofocused")).toBeNull();

      // Make visible
      input.style.display = "block";

      // Wait for MutationObserver to process
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should now be marked for autofocus
      expect(input.getAttribute("data-lvt-autofocused")).toBe("true");
    });
  });

  describe("window keydown skip-when-typing guard", () => {
    const setupWindowKeydown = (wrapperId: string, innerHTML: string) => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", wrapperId);
      wrapper.innerHTML = innerHTML;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupWindowEventDelegation();
      return { wrapper, context };
    };

    const pressKey = (key: string) => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key }));
    };

    it("suppresses an opted-in binding while a textarea is focused", () => {
      const { wrapper, context } = setupWindowKeydown(
        "wrapper-guard-textarea",
        `
          <div lvt-on:window:keydown="nextFile" lvt-key="j" lvt-mod:skip-when-typing></div>
          <textarea id="composer"></textarea>
        `
      );
      (wrapper.querySelector("#composer") as HTMLTextAreaElement).focus();

      pressKey("j");

      expect(context.send).not.toHaveBeenCalled();
    });

    it("fires a Mod+Enter binding on Cmd/Ctrl+Enter and prevents the default", () => {
      const { context } = setupWindowKeydown(
        "wrapper-mod-enter",
        `<form lvt-on:window:keydown="addComment" lvt-key="Mod+Enter"></form>`
      );
      const e = new KeyboardEvent("keydown", {
        key: "Enter",
        metaKey: true,
        cancelable: true,
      });
      const prevented = jest.spyOn(e, "preventDefault");
      window.dispatchEvent(e);

      expect(context.send).toHaveBeenCalledWith(
        expect.objectContaining({ action: "addComment" })
      );
      // The chord is consumed so it doesn't also type a newline into the field.
      expect(prevented).toHaveBeenCalled();
    });

    it("does NOT fire a Mod+Enter binding on a plain Enter (newline preserved)", () => {
      const { context } = setupWindowKeydown(
        "wrapper-mod-enter-plain",
        `<form lvt-on:window:keydown="addComment" lvt-key="Mod+Enter"></form>`
      );
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

      expect(context.send).not.toHaveBeenCalled();
    });

    it("suppresses an opted-in binding while a text input is focused", () => {
      const { wrapper, context } = setupWindowKeydown(
        "wrapper-guard-input",
        `
          <div lvt-on:window:keydown="nextFile" lvt-key="j" lvt-mod:skip-when-typing></div>
          <input id="filter" type="text" />
        `
      );
      (wrapper.querySelector("#filter") as HTMLInputElement).focus();

      pressKey("j");

      expect(context.send).not.toHaveBeenCalled();
    });

    it("suppresses an opted-in binding while a contenteditable region is focused", () => {
      const { wrapper, context } = setupWindowKeydown(
        "wrapper-guard-ce",
        `
          <div lvt-on:window:keydown="nextFile" lvt-key="j" lvt-mod:skip-when-typing></div>
          <div id="rich" contenteditable="true" tabindex="0"></div>
        `
      );
      (wrapper.querySelector("#rich") as HTMLElement).focus();

      pressKey("j");

      expect(context.send).not.toHaveBeenCalled();
    });

    it("suppresses an opted-in binding while a shadow-DOM input is focused", () => {
      const { wrapper, context } = setupWindowKeydown(
        "wrapper-guard-shadow",
        `
          <div lvt-on:window:keydown="nextFile" lvt-key="j" lvt-mod:skip-when-typing></div>
          <div id="host"></div>
        `
      );
      // document.activeElement returns the shadow HOST, so the guard must
      // descend through shadowRoot.activeElement to find the real input.
      const host = wrapper.querySelector("#host") as HTMLElement;
      const root = host.attachShadow({ mode: "open" });
      const input = document.createElement("textarea");
      root.appendChild(input);
      input.focus();

      pressKey("j");

      expect(context.send).not.toHaveBeenCalled();
    });

    it("fires an opted-in binding when focus is on a non-editable element", () => {
      const { wrapper, context } = setupWindowKeydown(
        "wrapper-guard-button",
        `
          <div lvt-on:window:keydown="nextFile" lvt-key="j" lvt-mod:skip-when-typing></div>
          <button id="go" type="button">go</button>
        `
      );
      (wrapper.querySelector("#go") as HTMLButtonElement).focus();

      pressKey("j");

      expect(context.send).toHaveBeenCalledTimes(1);
      expect(context.send).toHaveBeenCalledWith({ action: "nextFile", data: {} });
    });

    it("suppresses an opted-in binding while a range input is focused (arrows adjust the slider)", () => {
      const { wrapper, context } = setupWindowKeydown(
        "wrapper-guard-range",
        `
          <div lvt-on:window:keydown="nextFile" lvt-key="ArrowDown" lvt-mod:skip-when-typing></div>
          <input id="slider" type="range" />
        `
      );
      (wrapper.querySelector("#slider") as HTMLInputElement).focus();

      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));

      // range inputs are intentionally "editable": the arrow goes to the slider,
      // not the shortcut.
      expect(context.send).not.toHaveBeenCalled();
    });

    it("guards keyup bindings too (skip-when-typing is not keydown-only)", () => {
      const { wrapper, context } = setupWindowKeydown(
        "wrapper-guard-keyup",
        `
          <div lvt-on:window:keyup="nextFile" lvt-key="j" lvt-mod:skip-when-typing></div>
          <textarea id="composer"></textarea>
        `
      );
      (wrapper.querySelector("#composer") as HTMLTextAreaElement).focus();

      window.dispatchEvent(new KeyboardEvent("keyup", { key: "j" }));

      expect(context.send).not.toHaveBeenCalled();
    });

    it("guards a skip-when-typing binding even without an lvt-key filter", () => {
      const { wrapper, context } = setupWindowKeydown(
        "wrapper-guard-nokey",
        `
          <div lvt-on:window:keydown="ping" lvt-mod:skip-when-typing></div>
          <textarea id="composer"></textarea>
        `
      );
      (wrapper.querySelector("#composer") as HTMLTextAreaElement).focus();

      pressKey("x"); // any key — no lvt-key filter on the binding

      expect(context.send).not.toHaveBeenCalled();
    });

    it("fires a binding WITHOUT the opt-in even while a textarea is focused (Escape case)", () => {
      const { wrapper, context } = setupWindowKeydown(
        "wrapper-guard-escape",
        `
          <div lvt-on:window:keydown="clearSelection" lvt-key="Escape"></div>
          <textarea id="composer"></textarea>
        `
      );
      (wrapper.querySelector("#composer") as HTMLTextAreaElement).focus();

      pressKey("Escape");

      expect(context.send).toHaveBeenCalledTimes(1);
      expect(context.send).toHaveBeenCalledWith({
        action: "clearSelection",
        data: {},
      });
    });
  });

  describe("orphan buttons (formless standalone)", () => {
    it("button with name triggers action", () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-orphan-1");
      wrapper.innerHTML = `<button id="inc" name="increment">+</button>`;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupEventDelegation();

      document.getElementById("inc")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      );

      expect(context.send).toHaveBeenCalledTimes(1);
      expect(context.send).toHaveBeenCalledWith({
        action: "increment",
        data: {},
      });
    });

    it("button value is sent as data", () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-orphan-2");
      wrapper.innerHTML = `<button id="del" name="delete" value="42">Delete</button>`;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupEventDelegation();

      document.getElementById("del")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      );

      expect(context.send).toHaveBeenCalledTimes(1);
      expect(context.send).toHaveBeenCalledWith({
        action: "delete",
        data: { value: "42" },
      });
    });

    it("button data-* attributes are sent as data", () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-orphan-3");
      wrapper.innerHTML = `<button id="edit" name="edit" data-id="7" data-mode="quick">Edit</button>`;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupEventDelegation();

      document.getElementById("edit")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      );

      expect(context.send).toHaveBeenCalledTimes(1);
      expect(context.send).toHaveBeenCalledWith({
        action: "edit",
        data: { id: "7", mode: "quick" },
      });
    });

    it("button inside form routes through form submit, not orphan path", () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-orphan-4");
      wrapper.innerHTML = `<form><button id="btn" name="save">Save</button></form>`;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupEventDelegation();

      document.getElementById("btn")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      );

      // Clicking a button inside a form triggers form submission.
      // The action routes through the submit path (setActiveSubmission called),
      // NOT the orphan button click path.
      expect(context.send).toHaveBeenCalledTimes(1);
      expect(context.send).toHaveBeenCalledWith(
        expect.objectContaining({ action: "save" })
      );
      expect(context.setActiveSubmission).toHaveBeenCalled();
    });

    it("button with form attribute routes through form submit, not orphan path", () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-orphan-5");
      wrapper.innerHTML = `<form id="myform"></form><button id="btn" form="myform" name="save">Save</button>`;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupEventDelegation();

      document.getElementById("btn")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      );

      // Clicking a button with form="myform" triggers submission of the associated form.
      // The action routes through the submit path (setActiveSubmission called),
      // NOT the orphan button click path.
      expect(context.send).toHaveBeenCalledTimes(1);
      expect(context.send).toHaveBeenCalledWith(
        expect.objectContaining({ action: "save" })
      );
      expect(context.setActiveSubmission).toHaveBeenCalled();
    });

    it("button without name is ignored", () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-orphan-6");
      wrapper.innerHTML = `<button id="btn">Click me</button>`;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupEventDelegation();

      document.getElementById("btn")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      );

      expect(context.send).not.toHaveBeenCalled();
    });

    it("type=reset button is ignored", () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-orphan-7");
      wrapper.innerHTML = `<button id="btn" type="reset" name="reset">Reset</button>`;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupEventDelegation();

      document.getElementById("btn")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      );

      expect(context.send).not.toHaveBeenCalled();
    });

    it("disabled button is ignored", () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-orphan-8");
      wrapper.innerHTML = `<button id="btn" name="action" disabled>Disabled</button>`;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupEventDelegation();

      document.getElementById("btn")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      );

      expect(context.send).not.toHaveBeenCalled();
    });

    it("type=button with name triggers action", () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-orphan-9");
      wrapper.innerHTML = `<button id="btn" type="button" name="doThing">Do Thing</button>`;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupEventDelegation();

      document.getElementById("btn")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      );

      expect(context.send).toHaveBeenCalledTimes(1);
      expect(context.send).toHaveBeenCalledWith({
        action: "doThing",
        data: {},
      });
    });

    it("type=submit orphan button triggers action (no form to submit)", () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-orphan-12");
      wrapper.innerHTML = `<button id="btn" type="submit" name="save">Save</button>`;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupEventDelegation();

      document.getElementById("btn")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      );

      // type="submit" outside a form has no form to submit —
      // treated as an orphan button, triggers the named action.
      expect(context.send).toHaveBeenCalledTimes(1);
      expect(context.send).toHaveBeenCalledWith({
        action: "save",
        data: {},
      });
    });

    it("lvt-on:click takes priority over orphan button name", () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-orphan-10");
      wrapper.innerHTML = `<button id="btn" lvt-on:click="tier2action" name="tier1action">Button</button>`;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupEventDelegation();

      document.getElementById("btn")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      );

      expect(context.send).toHaveBeenCalledTimes(1);
      expect(context.send).toHaveBeenCalledWith(
        expect.objectContaining({ action: "tier2action" })
      );
    });

    it("button with commandfor is ignored", () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-orphan-11");
      wrapper.innerHTML = `<button id="btn" name="show" commandfor="dialog1" command="show-modal">Open</button>`;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupEventDelegation();

      document.getElementById("btn")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      );

      expect(context.send).not.toHaveBeenCalled();
    });

    it("clicking child element inside orphan button still extracts data", () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-orphan-13");
      wrapper.innerHTML = `<button id="btn" name="toggle" value="99" data-id="5"><span id="icon">★</span></button>`;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupEventDelegation();

      // Click the child <span>, not the button directly
      document.getElementById("icon")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      );

      expect(context.send).toHaveBeenCalledTimes(1);
      expect(context.send).toHaveBeenCalledWith({
        action: "toggle",
        data: { value: "99", id: "5" },
      });
    });
  });

  describe("drag events", () => {
    // JSDOM's DragEvent and DataTransfer are not faithful to the spec
    // (DataTransfer constructor missing in many versions, dataTransfer
    // field on DragEvent often null). We build a Map-backed DataTransfer
    // mock and attach it via defineProperty so the production code's
    // `(e as DragEvent).dataTransfer` reads our mock.
    const buildDataTransferMock = () => {
      const store = new Map<string, string>();
      const mock = {
        setData: jest.fn((type: string, value: string) => {
          store.set(type, value);
        }),
        getData: jest.fn((type: string) => store.get(type) ?? ""),
        effectAllowed: "uninitialized" as DataTransfer["effectAllowed"],
        dropEffect: "none" as DataTransfer["dropEffect"],
      };
      return { store, mock };
    };

    const dispatchDrag = (
      target: Element,
      type: string,
      dt?: ReturnType<typeof buildDataTransferMock>["mock"],
      relatedTarget?: Element | null
    ) => {
      const evt = new Event(type, { bubbles: true, cancelable: true });
      if (dt) {
        Object.defineProperty(evt, "dataTransfer", {
          value: dt,
          writable: false,
          configurable: true,
        });
      }
      if (relatedTarget !== undefined) {
        Object.defineProperty(evt, "relatedTarget", {
          value: relatedTarget,
          writable: false,
          configurable: true,
        });
      }
      target.dispatchEvent(evt);
      return evt;
    };

    it("dragstart stashes data-key into the LVT MIME only (never text/plain)", () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-drag-1");
      wrapper.innerHTML = `
        <li id="src" data-key="task-3" lvt-on:dragstart="startDrag"></li>
      `;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupEventDelegation();

      const { store, mock } = buildDataTransferMock();
      dispatchDrag(document.getElementById("src")!, "dragstart", mock);

      expect(mock.setData).toHaveBeenCalledWith("application/x-lvt-key", "task-3");
      expect(store.get("application/x-lvt-key")).toBe("task-3");
      // Critical: text/plain is NOT set, so the key cannot leak to
      // external drop targets (URL bar, text editor, another app).
      expect(store.has("text/plain")).toBe(false);
      expect(context.send).toHaveBeenCalledWith({ action: "startDrag", data: {} });
    });

    it("dragstart sets effectAllowed to 'move'", () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-drag-2");
      wrapper.innerHTML = `<li id="src" data-key="x" lvt-on:dragstart="d"></li>`;
      document.body.appendChild(wrapper);

      const delegator = new EventDelegator(
        createContext(wrapper),
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupEventDelegation();

      const { mock } = buildDataTransferMock();
      dispatchDrag(document.getElementById("src")!, "dragstart", mock);

      expect(mock.effectAllowed).toBe("move");
    });

    it("dragstart with no enclosing data-key sends empty key without throwing", () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-drag-3");
      wrapper.innerHTML = `<div id="src" lvt-on:dragstart="d"></div>`;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupEventDelegation();

      const { mock } = buildDataTransferMock();
      expect(() =>
        dispatchDrag(document.getElementById("src")!, "dragstart", mock)
      ).not.toThrow();

      expect(mock.setData).toHaveBeenCalledWith("application/x-lvt-key", "");
      expect(context.send).toHaveBeenCalledWith({ action: "d", data: {} });
    });

    it("dragover preventDefaults on every event even when send is throttled", () => {
      jest.useFakeTimers();

      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-drag-4");
      wrapper.innerHTML = `
        <li id="tgt" data-key="t" lvt-on:dragover="over" lvt-mod:throttle="200"></li>
      `;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupEventDelegation();

      const target = document.getElementById("tgt")!;
      const { mock } = buildDataTransferMock();

      const e1 = dispatchDrag(target, "dragover", mock);
      const e2 = dispatchDrag(target, "dragover", mock);
      const e3 = dispatchDrag(target, "dragover", mock);

      // preventDefault is called on every event (not throttled)
      expect(e1.defaultPrevented).toBe(true);
      expect(e2.defaultPrevented).toBe(true);
      expect(e3.defaultPrevented).toBe(true);

      // send is throttled — only fired once
      expect(context.send).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(200);
      dispatchDrag(target, "dragover", mock);
      expect(context.send).toHaveBeenCalledTimes(2);
    });

    it("dragover sets dropEffect to 'move'", () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-drag-5");
      wrapper.innerHTML = `<li id="tgt" data-key="t" lvt-on:dragover="o"></li>`;
      document.body.appendChild(wrapper);

      const delegator = new EventDelegator(
        createContext(wrapper),
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupEventDelegation();

      const { mock } = buildDataTransferMock();
      dispatchDrag(document.getElementById("tgt")!, "dragover", mock);

      expect(mock.dropEffect).toBe("move");
    });

    it("drop injects dragSourceKey from DataTransfer and dragTargetKey from DOM", () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-drag-6");
      wrapper.innerHTML = `
        <ul>
          <li id="tgt" data-key="task-1" lvt-on:drop="reorder"></li>
        </ul>
      `;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupEventDelegation();

      const { store, mock } = buildDataTransferMock();
      store.set("application/x-lvt-key", "task-3");
      dispatchDrag(document.getElementById("tgt")!, "drop", mock);

      expect(context.send).toHaveBeenCalledWith({
        action: "reorder",
        data: { dragSourceKey: "task-3", dragTargetKey: "task-1" },
      });
    });

    it("drop calls preventDefault to suppress browser navigation", () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-drag-7");
      wrapper.innerHTML = `<li id="tgt" data-key="t" lvt-on:drop="d"></li>`;
      document.body.appendChild(wrapper);

      const delegator = new EventDelegator(
        createContext(wrapper),
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupEventDelegation();

      const { mock } = buildDataTransferMock();
      const evt = dispatchDrag(document.getElementById("tgt")!, "drop", mock);
      expect(evt.defaultPrevented).toBe(true);
    });

    it("drop ignores text/plain-only DataTransfer (cross-app drag is untrusted)", () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-drag-8");
      wrapper.innerHTML = `<li id="tgt" data-key="t" lvt-on:drop="d"></li>`;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupEventDelegation();

      const { store, mock } = buildDataTransferMock();
      // Simulates a drag from outside the app — only text/plain is set,
      // LVT MIME is absent. The drop must NOT promote arbitrary text
      // to dragSourceKey.
      store.set("text/plain", "arbitrary external text");
      dispatchDrag(document.getElementById("tgt")!, "drop", mock);

      const call = context.send.mock.calls[0][0];
      expect(call.action).toBe("d");
      expect(call.data.dragTargetKey).toBe("t");
      expect(call.data).not.toHaveProperty("dragSourceKey");
    });

    it("drop with no MIME data injects only dragTargetKey", () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-drag-9");
      wrapper.innerHTML = `<li id="tgt" data-key="t" lvt-on:drop="d"></li>`;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupEventDelegation();

      const { mock } = buildDataTransferMock();
      dispatchDrag(document.getElementById("tgt")!, "drop", mock);

      const call = context.send.mock.calls[0][0];
      expect(call.action).toBe("d");
      expect(call.data.dragTargetKey).toBe("t");
      expect(call.data).not.toHaveProperty("dragSourceKey");
    });

    it("drop without dataTransfer still injects dragTargetKey from the DOM", () => {
      // Some embedded / synthetic-event environments produce DragEvents
      // with no DataTransfer. dragSourceKey is unavailable in that case
      // (it's stashed via DataTransfer), but dragTargetKey is derived
      // from the DOM and must still be sent.
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-drag-no-dt");
      wrapper.innerHTML = `<li id="tgt" data-key="task-X" lvt-on:drop="d"></li>`;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupEventDelegation();

      // dispatchDrag without a mock DataTransfer
      dispatchDrag(document.getElementById("tgt")!, "drop");

      const call = context.send.mock.calls[0][0];
      expect(call.action).toBe("d");
      expect(call.data.dragTargetKey).toBe("task-X");
      expect(call.data).not.toHaveProperty("dragSourceKey");
    });

    it("drop on nested element resolves dragTargetKey via closest data-key", () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-drag-10");
      wrapper.innerHTML = `
        <ul>
          <li data-key="task-5">
            <span id="inner" lvt-on:drop="reorder"></span>
          </li>
        </ul>
      `;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupEventDelegation();

      const { store, mock } = buildDataTransferMock();
      store.set("application/x-lvt-key", "task-2");
      dispatchDrag(document.getElementById("inner")!, "drop", mock);

      expect(context.send).toHaveBeenCalledWith({
        action: "reorder",
        data: { dragSourceKey: "task-2", dragTargetKey: "task-5" },
      });
    });

    it("dragend forwards as a plain action (no drag-specific data injection)", () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-drag-11");
      wrapper.innerHTML = `<li id="src" data-key="x" lvt-on:dragend="cleanup"></li>`;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupEventDelegation();

      const { mock } = buildDataTransferMock();
      dispatchDrag(document.getElementById("src")!, "dragend", mock);

      expect(context.send).toHaveBeenCalledWith({ action: "cleanup", data: {} });
      // No drag-specific keys leaked into payload
      expect(mock.setData).not.toHaveBeenCalled();
    });

    it("dragenter is suppressed when relatedTarget is a child of the action element", () => {
      // The spec fires dragenter as the pointer crosses into a child
      // of an existing drop target — that's noise. Our handler should
      // suppress it and only fire on real boundary crossings.
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-drag-enter-noise");
      wrapper.innerHTML = `
        <li id="zone" data-key="t" lvt-on:dragenter="enter">
          <span id="child"></span>
        </li>
      `;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupEventDelegation();

      // Fire dragenter on the zone with the child as relatedTarget —
      // simulates pointer crossing from the zone proper into the child.
      const child = document.getElementById("child")!;
      dispatchDrag(document.getElementById("zone")!, "dragenter", undefined, child);

      expect(context.send).not.toHaveBeenCalled();
    });

    it("dragleave fires for boundary crossings between distinct elements", () => {
      // Real boundary crossing: pointer leaves the zone for an element
      // outside it. relatedTarget is NOT a child, so the action fires.
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-drag-leave-real");
      wrapper.innerHTML = `
        <ul>
          <li id="zone-a" data-key="a" lvt-on:dragleave="leave"></li>
          <li id="zone-b" data-key="b"></li>
        </ul>
      `;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupEventDelegation();

      const zoneB = document.getElementById("zone-b")!;
      dispatchDrag(document.getElementById("zone-a")!, "dragleave", undefined, zoneB);

      expect(context.send).toHaveBeenCalledWith({ action: "leave", data: {} });
    });

    it("dragenter forwards as a plain action", () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-drag-12");
      wrapper.innerHTML = `<li id="tgt" data-key="t" lvt-on:dragenter="enter"></li>`;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupEventDelegation();

      dispatchDrag(document.getElementById("tgt")!, "dragenter");

      expect(context.send).toHaveBeenCalledWith({ action: "enter", data: {} });
    });

    it("dragleave forwards as a plain action", () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-drag-13");
      wrapper.innerHTML = `<li id="tgt" data-key="t" lvt-on:dragleave="leave"></li>`;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupEventDelegation();

      dispatchDrag(document.getElementById("tgt")!, "dragleave");

      expect(context.send).toHaveBeenCalledWith({ action: "leave", data: {} });
    });

    it("dragover with empty action calls preventDefault but skips send", () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-drag-empty-over");
      // Empty action — marker pattern: opt into preventDefault without WS send
      wrapper.innerHTML = `<li id="tgt" data-key="t" lvt-on:dragover=""></li>`;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupEventDelegation();

      const { mock } = buildDataTransferMock();
      const evt = dispatchDrag(document.getElementById("tgt")!, "dragover", mock);

      expect(evt.defaultPrevented).toBe(true);
      expect(context.send).not.toHaveBeenCalled();
    });

    it("dragstart with empty action stashes key but skips send", () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-drag-empty-start");
      wrapper.innerHTML = `<li id="src" data-key="task-7" lvt-on:dragstart=""></li>`;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupEventDelegation();

      const { store, mock } = buildDataTransferMock();
      dispatchDrag(document.getElementById("src")!, "dragstart", mock);

      expect(store.get("application/x-lvt-key")).toBe("task-7");
      expect(context.send).not.toHaveBeenCalled();
    });

    it("end-to-end reorder flow: dragstart then drop produces expected payload", () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-drag-14");
      wrapper.innerHTML = `
        <ul>
          <li id="i1" data-key="task-1" draggable="true" lvt-on:dragstart="dnd" lvt-on:drop="dnd"></li>
          <li id="i2" data-key="task-2" draggable="true" lvt-on:dragstart="dnd" lvt-on:drop="dnd"></li>
          <li id="i3" data-key="task-3" draggable="true" lvt-on:dragstart="dnd" lvt-on:drop="dnd"></li>
        </ul>
      `;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupEventDelegation();

      // Simulate a real drag: shared DataTransfer across the gesture.
      const { mock } = buildDataTransferMock();
      dispatchDrag(document.getElementById("i1")!, "dragstart", mock);
      dispatchDrag(document.getElementById("i3")!, "drop", mock);

      // First call: dragstart on i1
      expect(context.send.mock.calls[0][0]).toEqual({ action: "dnd", data: {} });
      // Second call: drop on i3 — payload carries source (from dataTransfer)
      // and target (from i3's data-key)
      expect(context.send.mock.calls[1][0]).toEqual({
        action: "dnd",
        data: { dragSourceKey: "task-1", dragTargetKey: "task-3" },
      });
    });
  });

  describe("explicit submitter on the wire (livetemplate#237 Phase 2)", () => {
    const setupForm = (
      innerHTML: string,
      wrapperId: string,
      overrides: Partial<EventDelegationContext> = {}
    ) => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", wrapperId);
      wrapper.innerHTML = innerHTML;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper, overrides);
      const delegator = new EventDelegator(
        context,
        createLogger({ scope: "EventDelegatorTest", level: "silent" })
      );
      delegator.setupEventDelegation();

      return { wrapper, context };
    };

    const dispatchSubmit = (form: HTMLFormElement, submitter: HTMLButtonElement | HTMLInputElement | null) => {
      // jsdom's SubmitEvent constructor does not accept a submitter option
      // (and pre-jsdom-20 didn't expose SubmitEvent at all), so we construct
      // a plain Event and assign .submitter directly. The cast matches the
      // existing pattern in this test file (see the password-field test
      // around line 130 for the canonical reference).
      const event = new Event("submit", {
        bubbles: true,
        cancelable: true,
      }) as SubmitEvent & { submitter?: HTMLButtonElement | HTMLInputElement | null };
      event.submitter = submitter;
      form.dispatchEvent(event);
    };

    it("WS message includes submitter field when submitter has a name", () => {
      const { context } = setupForm(
        `<form id="post-form">
          <input name="title" value="My Post" />
          <button type="submit" id="draft-btn" name="draft">Save as Draft</button>
        </form>`,
        "wrapper-submitter-ws-named"
      );

      const form = document.getElementById("post-form") as HTMLFormElement;
      const draftBtn = document.getElementById("draft-btn") as HTMLButtonElement;
      dispatchSubmit(form, draftBtn);

      expect(context.send).toHaveBeenCalledTimes(1);
      expect(context.send).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "draft",
          submitter: "draft",
        })
      );
    });

    it("WS message omits submitter field when submitter has no name", () => {
      const { context } = setupForm(
        `<form id="anon-form" lvt-form:action="post">
          <input name="title" value="My Post" />
          <button type="submit" id="anon-btn">Post</button>
        </form>`,
        "wrapper-submitter-ws-unnamed"
      );

      const form = document.getElementById("anon-form") as HTMLFormElement;
      const anonBtn = document.getElementById("anon-btn") as HTMLButtonElement;
      dispatchSubmit(form, anonBtn);

      expect(context.send).toHaveBeenCalledTimes(1);
      const sent = context.send.mock.calls[0][0];
      expect(sent.action).toBe("post");
      expect(sent.submitter).toBeUndefined();
    });

    it("HTTP Tier 1 multipart sets lvt-submitter when submitter has a name", () => {
      const { context } = setupForm(
        `<form id="upload-form">
          <input type="file" id="file-input" name="avatar" />
          <button type="submit" id="save-btn" name="save">Save</button>
        </form>`,
        "wrapper-submitter-multipart"
      );

      const form = document.getElementById("upload-form") as HTMLFormElement;
      const fileInput = document.getElementById("file-input") as HTMLInputElement;
      const saveBtn = document.getElementById("save-btn") as HTMLButtonElement;

      // jsdom: stub the FileList so the Tier 1 multipart path triggers.
      Object.defineProperty(fileInput, "files", {
        value: [new File(["data"], "avatar.png", { type: "image/png" })],
        configurable: true,
      });

      dispatchSubmit(form, saveBtn);

      expect(context.sendHTTPMultipart).toHaveBeenCalledTimes(1);
      const [, action, formData] = (context.sendHTTPMultipart as jest.Mock).mock.calls[0];
      expect(action).toBe("save");
      expect((formData as FormData).get("lvt-action")).toBe("save");
      expect((formData as FormData).get("lvt-submitter")).toBe("save");
    });

    it("lvt-form:emit-submitter creates hidden input on first submit (click)", () => {
      const { context } = setupForm(
        `<form id="native-form" lvt-form:no-intercept lvt-form:emit-submitter action="/post" method="POST">
          <input name="title" value="Hello" />
          <button type="submit" id="draft-btn" name="draft">Save as Draft</button>
        </form>`,
        "wrapper-emit-submitter-click"
      );

      const form = document.getElementById("native-form") as HTMLFormElement;
      const draftBtn = document.getElementById("draft-btn") as HTMLButtonElement;

      expect(form.querySelector('input[name="lvt-submitter"]')).toBeNull();

      dispatchSubmit(form, draftBtn);

      const hiddenInput = form.querySelector<HTMLInputElement>('input[name="lvt-submitter"]');
      expect(hiddenInput).not.toBeNull();
      expect(hiddenInput!.type).toBe("hidden");
      expect(hiddenInput!.value).toBe("draft");
      // Non-intercepted form: client did not send a WS message.
      expect(context.send).not.toHaveBeenCalled();
    });

    it("lvt-form:emit-submitter populates hidden input on keyboard submit (Enter)", () => {
      // Simulates browser behavior: Enter in a text input selects the form's
      // default submit button as SubmitEvent.submitter. Form uses POST to
      // avoid the URL-pollution caveat documented in the directive — GET
      // forms serialize lvt-submitter into the query string, which is fine
      // for apps that opt in but unhelpful as a default in tests.
      setupForm(
        `<form id="search-form" lvt-form:no-intercept lvt-form:emit-submitter action="/q" method="POST">
          <input type="text" name="q" value="hello" />
          <button type="submit" id="default-submit" name="go">Go</button>
        </form>`,
        "wrapper-emit-submitter-keyboard"
      );

      const form = document.getElementById("search-form") as HTMLFormElement;
      const defaultSubmit = document.getElementById("default-submit") as HTMLButtonElement;

      dispatchSubmit(form, defaultSubmit);

      const hiddenInput = form.querySelector<HTMLInputElement>('input[name="lvt-submitter"]');
      expect(hiddenInput).not.toBeNull();
      expect(hiddenInput!.value).toBe("go");
    });

    it("lvt-form:emit-submitter clears stale hidden input on unnamed follow-up submission", () => {
      // Regression: a named submit creates the hidden input with "save",
      // then an unnamed submit must not leave that value on the form.
      // Without the clear-on-unnamed branch, the server would receive
      // the stale value and misroute the unnamed submit to the "save"
      // action.
      setupForm(
        `<form id="seq-form" lvt-form:no-intercept lvt-form:emit-submitter action="/post" method="POST">
          <input name="title" value="Hello" />
          <button type="submit" id="save-btn" name="save">Save</button>
          <button type="submit" id="unnamed-btn">Submit</button>
        </form>`,
        "wrapper-emit-submitter-named-then-unnamed"
      );

      const form = document.getElementById("seq-form") as HTMLFormElement;
      const saveBtn = document.getElementById("save-btn") as HTMLButtonElement;
      const unnamedBtn = document.getElementById("unnamed-btn") as HTMLButtonElement;

      dispatchSubmit(form, saveBtn);
      expect(
        form.querySelector<HTMLInputElement>('input[type="hidden"][name="lvt-submitter"]')!.value
      ).toBe("save");

      dispatchSubmit(form, unnamedBtn);
      expect(form.querySelector('input[name="lvt-submitter"]')).toBeNull();
    });

    it("lvt-form:emit-submitter does not create hidden input when submitter has no name", () => {
      // Matches the WS and HTTP-multipart paths: when SubmitEvent.submitter
      // has no name (or is null), do not write lvt-submitter. The server
      // falls back to the heuristic for that submission. No empty-string
      // lvt-submitter="" appears on the wire.
      setupForm(
        `<form id="anon-form" lvt-form:no-intercept lvt-form:emit-submitter action="/post" method="POST">
          <input name="title" value="Hello" />
          <button type="submit" id="unnamed-btn">Submit</button>
        </form>`,
        "wrapper-emit-submitter-no-name"
      );

      const form = document.getElementById("anon-form") as HTMLFormElement;
      const unnamedBtn = document.getElementById("unnamed-btn") as HTMLButtonElement;

      dispatchSubmit(form, unnamedBtn);

      expect(form.querySelector('input[name="lvt-submitter"]')).toBeNull();
    });

    it("lvt-form:emit-submitter updates existing hidden input on subsequent submits", () => {
      setupForm(
        `<form id="multi-btn-form" lvt-form:no-intercept lvt-form:emit-submitter action="/post" method="POST">
          <input name="title" value="My Post" />
          <button type="submit" id="save-btn" name="save">Save</button>
          <button type="submit" id="draft-btn" name="draft">Save as Draft</button>
        </form>`,
        "wrapper-emit-submitter-update"
      );

      const form = document.getElementById("multi-btn-form") as HTMLFormElement;
      const saveBtn = document.getElementById("save-btn") as HTMLButtonElement;
      const draftBtn = document.getElementById("draft-btn") as HTMLButtonElement;

      dispatchSubmit(form, saveBtn);
      let hiddenInput = form.querySelector<HTMLInputElement>('input[name="lvt-submitter"]');
      expect(hiddenInput!.value).toBe("save");

      dispatchSubmit(form, draftBtn);
      hiddenInput = form.querySelector<HTMLInputElement>('input[name="lvt-submitter"]');
      expect(hiddenInput!.value).toBe("draft");
      // Exactly one hidden input — not created twice.
      expect(form.querySelectorAll('input[name="lvt-submitter"]').length).toBe(1);
    });

    it("lvt-form:emit-submitter does not hijack a developer-authored visible lvt-submitter input", () => {
      // Regression for a selector bug: looking up the lvt-submitter input
      // without an explicit type="hidden" filter would silently mutate any
      // existing user-visible <input name="lvt-submitter"> in the form.
      setupForm(
        `<form id="manual-form" lvt-form:no-intercept lvt-form:emit-submitter action="/post" method="POST">
          <input type="text" name="lvt-submitter" value="user-chose-me" id="visible-input" />
          <button type="submit" id="save-btn" name="save">Save</button>
        </form>`,
        "wrapper-emit-submitter-hidden-only"
      );

      const form = document.getElementById("manual-form") as HTMLFormElement;
      const saveBtn = document.getElementById("save-btn") as HTMLButtonElement;
      const visibleInput = document.getElementById("visible-input") as HTMLInputElement;

      dispatchSubmit(form, saveBtn);

      // Visible input must not have been touched.
      expect(visibleInput.value).toBe("user-chose-me");
      expect(visibleInput.type).toBe("text");

      // A separate hidden input was injected for the directive's purpose.
      const hiddenInput = form.querySelector<HTMLInputElement>(
        'input[type="hidden"][name="lvt-submitter"]'
      );
      expect(hiddenInput).not.toBeNull();
      expect(hiddenInput!.value).toBe("save");

      // Two inputs named lvt-submitter coexist: one user-visible (declared
      // first in the markup, so it appears first in DOM order), one hidden
      // (appended by the directive). The native browser form serializer
      // sends both values in DOM order, and the server's
      // r.FormValue("lvt-submitter") returns the first value — so the
      // user-visible input's value wins and the directive's hidden input is
      // effectively a no-op for this submission. This matches the proposal's
      // reserved-name semantics: apps that put user data in a field named
      // lvt-submitter accept that the value will be routed as the submitter
      // (i.e., used as the action), which is exactly what the developer
      // asked for in this scenario even if accidentally. The framework
      // does not arbitrate this conflict client-side.
      const inputs = form.querySelectorAll('input[name="lvt-submitter"]');
      expect(inputs.length).toBe(2);
      expect(inputs[0]).toBe(visibleInput);
      expect((inputs[1] as HTMLInputElement).type).toBe("hidden");
    });

    it("lvt-form:emit-submitter does not warn on GET form when submitter is unnamed (no field injected)", () => {
      // Regression for a false-positive bug: an earlier draft of the
      // warning fired on every GET-form submission, even when the
      // submitter had no name and the directive was about to skip
      // injection. No injection means no URL pollution, so no warning.
      const warnSpy = jest.fn();
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-emit-submitter-get-no-name");
      wrapper.innerHTML = `<form id="get-anon-form" lvt-form:no-intercept lvt-form:emit-submitter action="/q" method="GET">
        <input type="text" name="q" value="hello" />
        <button type="submit" id="anon-btn">Submit</button>
      </form>`;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        { debug: jest.fn(), info: jest.fn(), warn: warnSpy, error: jest.fn() } as any
      );
      delegator.setupEventDelegation();

      const form = document.getElementById("get-anon-form") as HTMLFormElement;
      const anonBtn = document.getElementById("anon-btn") as HTMLButtonElement;

      dispatchSubmit(form, anonBtn);

      expect(warnSpy).not.toHaveBeenCalled();
      expect(form.querySelector('input[name="lvt-submitter"]')).toBeNull();
    });

    it("lvt-form:emit-submitter warns once per form when used on a GET form", () => {
      const warnSpy = jest.fn();
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-emit-submitter-get-warn");
      wrapper.innerHTML = `<form id="get-form" lvt-form:no-intercept lvt-form:emit-submitter action="/q" method="GET">
        <input type="text" name="q" value="hello" />
        <button type="submit" id="go-btn" name="go">Go</button>
      </form>`;
      document.body.appendChild(wrapper);

      const context = createContext(wrapper);
      const delegator = new EventDelegator(
        context,
        // Custom logger captures warn calls without scoping or formatting.
        { debug: jest.fn(), info: jest.fn(), warn: warnSpy, error: jest.fn() } as any
      );
      delegator.setupEventDelegation();

      const form = document.getElementById("get-form") as HTMLFormElement;
      const goBtn = document.getElementById("go-btn") as HTMLButtonElement;

      dispatchSubmit(form, goBtn);
      dispatchSubmit(form, goBtn);
      dispatchSubmit(form, goBtn);

      // Warning emitted exactly once across three submissions.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain("lvt-form:emit-submitter");
      expect(warnSpy.mock.calls[0][0]).toContain("GET");
    });

    it("lvt-form:emit-submitter does not run when form is auto-intercepted", () => {
      // Without lvt-form:no-intercept, the auto-intercept path handles the
      // submitter via __lvtSubmitter / message.submitter — no hidden input
      // should be injected into the form.
      const { context } = setupForm(
        `<form id="intercepted-form" lvt-form:emit-submitter>
          <input name="title" value="Hello" />
          <button type="submit" id="save-btn" name="save">Save</button>
        </form>`,
        "wrapper-emit-submitter-intercepted"
      );

      const form = document.getElementById("intercepted-form") as HTMLFormElement;
      const saveBtn = document.getElementById("save-btn") as HTMLButtonElement;
      dispatchSubmit(form, saveBtn);

      expect(form.querySelector('input[name="lvt-submitter"]')).toBeNull();
      expect(context.send).toHaveBeenCalledWith(
        expect.objectContaining({ action: "save", submitter: "save" })
      );
    });
  });
});

describe("keyFilterMatches (lvt-key)", () => {
  const ev = (key: string, mods: Partial<KeyboardEventInit> = {}) =>
    new KeyboardEvent("keydown", { key, ...mods });

  it("matches a bare key verbatim regardless of modifiers (back-compat)", () => {
    expect(keyFilterMatches(ev("Enter"), "Enter")).toEqual({
      matched: true,
      combo: false,
    });
    // A bare "Enter" filter still matches a modified Enter — unchanged from
    // the old exact-equality behavior, so existing bindings are untouched.
    expect(keyFilterMatches(ev("Enter", { metaKey: true }), "Enter")).toEqual({
      matched: true,
      combo: false,
    });
    expect(keyFilterMatches(ev("Escape"), "Enter").matched).toBe(false);
    expect(keyFilterMatches(ev("j"), "j").matched).toBe(true);
  });

  it("matches the literal '+' key as a bare filter", () => {
    expect(keyFilterMatches(ev("+"), "+")).toEqual({
      matched: true,
      combo: false,
    });
  });

  it("Mod+Enter matches metaKey OR ctrlKey, never a plain Enter", () => {
    expect(keyFilterMatches(ev("Enter", { metaKey: true }), "Mod+Enter")).toEqual(
      { matched: true, combo: true }
    );
    expect(keyFilterMatches(ev("Enter", { ctrlKey: true }), "Mod+Enter")).toEqual(
      { matched: true, combo: true }
    );
    expect(keyFilterMatches(ev("Enter"), "Mod+Enter")).toEqual({
      matched: false,
      combo: true,
    });
  });

  it("distinguishes Meta+ from Ctrl+", () => {
    expect(keyFilterMatches(ev("Enter", { metaKey: true }), "Meta+Enter").matched).toBe(true);
    expect(keyFilterMatches(ev("Enter", { ctrlKey: true }), "Meta+Enter").matched).toBe(false);
    expect(keyFilterMatches(ev("Enter", { ctrlKey: true }), "Control+Enter").matched).toBe(true);
    expect(keyFilterMatches(ev("Enter", { metaKey: true }), "Ctrl+Enter").matched).toBe(false);
  });

  it("supports Shift, Alt, and multi-modifier combos", () => {
    expect(keyFilterMatches(ev("ArrowDown", { shiftKey: true }), "Shift+ArrowDown").matched).toBe(true);
    expect(keyFilterMatches(ev("ArrowDown"), "Shift+ArrowDown").matched).toBe(false);
    expect(keyFilterMatches(ev("s", { metaKey: true, shiftKey: true }), "Mod+Shift+s").matched).toBe(true);
    expect(keyFilterMatches(ev("s", { metaKey: true }), "Mod+Shift+s").matched).toBe(false);
  });

  it("is lenient about extra modifiers beyond those named", () => {
    expect(keyFilterMatches(ev("Enter", { metaKey: true, shiftKey: true }), "Mod+Enter").matched).toBe(true);
  });

  it("rejects an unknown modifier token", () => {
    expect(keyFilterMatches(ev("Enter", { metaKey: true }), "Hyper+Enter").matched).toBe(false);
  });

  it("requires the key to match even with the right modifiers", () => {
    expect(keyFilterMatches(ev("Escape", { metaKey: true }), "Mod+Enter").matched).toBe(false);
  });
});
