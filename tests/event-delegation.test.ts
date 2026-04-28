import {
  EventDelegator,
  EventDelegationContext,
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
      dt?: ReturnType<typeof buildDataTransferMock>["mock"]
    ) => {
      const evt = new Event(type, { bubbles: true, cancelable: true });
      if (dt) {
        Object.defineProperty(evt, "dataTransfer", {
          value: dt,
          writable: false,
          configurable: true,
        });
      }
      target.dispatchEvent(evt);
      return evt;
    };

    it("dragstart stashes data-key into both LVT MIME and text/plain", () => {
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
      expect(mock.setData).toHaveBeenCalledWith("text/plain", "task-3");
      expect(store.get("application/x-lvt-key")).toBe("task-3");
      expect(store.get("text/plain")).toBe("task-3");
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
});
