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
  });
});
