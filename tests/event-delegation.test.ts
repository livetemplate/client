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
      setActiveSubmission: jest.fn(),
      openModal: jest.fn(),
      closeModal: jest.fn(),
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
      <button id="save" lvt-click="save" lvt-data-id="42"></button>
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
      <button id="ping" lvt-click="ping" lvt-throttle="200"></button>
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
      <form id="login-form" lvt-submit="login">
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
      <form id="add-form" lvt-submit="add">
        <input type="text" name="title" value="Hello" />
        <input type="checkbox" name="published" checked />
        <button type="submit" id="submit" lvt-disable-with="Saving...">Save</button>
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

    it("lvt-click takes priority over orphan button name", () => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-lvt-id", "wrapper-orphan-10");
      wrapper.innerHTML = `<button id="btn" lvt-click="tier2action" name="tier1action">Button</button>`;
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
});
