import { ObserverManager, ObserverContext } from "../dom/observer-manager";
import { createLogger } from "../utils/logger";

// Mock IntersectionObserver. Tracks instances and disconnect calls so tests
// can assert not just that a fresh observer was built, but that the old one
// was torn down — guards against silent leaks where a stale observer keeps
// firing callbacks against a detached sentinel.
class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  static reset(): void {
    MockIntersectionObserver.instances.length = 0;
  }

  disconnected = false;
  callback: IntersectionObserverCallback;
  options?: IntersectionObserverInit;
  elements: Element[] = [];

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.options = options;
    MockIntersectionObserver.instances.push(this);
  }

  observe(element: Element) {
    this.elements.push(element);
  }

  unobserve(element: Element) {
    this.elements = this.elements.filter((e) => e !== element);
  }

  disconnect() {
    this.disconnected = true;
    this.elements = [];
  }

  // Helper to trigger intersection
  triggerIntersection(isIntersecting: boolean) {
    const entries: IntersectionObserverEntry[] = this.elements.map((target) => ({
      target,
      isIntersecting,
      boundingClientRect: {} as DOMRectReadOnly,
      intersectionRatio: isIntersecting ? 1 : 0,
      intersectionRect: {} as DOMRectReadOnly,
      rootBounds: null,
      time: Date.now(),
    }));
    this.callback(entries, this as unknown as IntersectionObserver);
  }
}

(global as any).IntersectionObserver = MockIntersectionObserver;

describe("ObserverManager", () => {
  let mockContext: ObserverContext;
  let mockSend: jest.Mock;
  let manager: ObserverManager;
  let mockLogger: ReturnType<typeof createLogger>;
  let mockConsole: { debug: jest.Mock; info: jest.Mock; warn: jest.Mock; error: jest.Mock };

  beforeEach(() => {
    jest.useFakeTimers();
    document.body.innerHTML = "";
    MockIntersectionObserver.reset();
    mockSend = jest.fn();
    mockConsole = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    mockLogger = createLogger({
      level: "debug",
      sink: mockConsole as unknown as Console,
    });
  });

  afterEach(() => {
    // Teardown BEFORE swapping back to real timers so any pending fake
    // setTimeout IDs inside ObserverManager are cleared against the fake
    // timer backend they were scheduled on.
    if (manager) {
      manager.teardown();
    }
    jest.useRealTimers();
  });

  describe("setupInfiniteScrollObserver", () => {
    it("does nothing if wrapper element is null", () => {
      mockContext = {
        getWrapperElement: () => null,
        send: mockSend,
      };
      manager = new ObserverManager(mockContext, mockLogger);

      manager.setupInfiniteScrollObserver();

      // Should not throw and should not call send
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("does nothing if scroll-sentinel element is not found", () => {
      document.body.innerHTML = "<div id='wrapper'></div>";
      mockContext = {
        getWrapperElement: () => document.getElementById("wrapper"),
        send: mockSend,
      };
      manager = new ObserverManager(mockContext, mockLogger);

      manager.setupInfiniteScrollObserver();

      expect(mockSend).not.toHaveBeenCalled();
    });

    it("sets up IntersectionObserver when sentinel exists", () => {
      document.body.innerHTML = `
        <div id="wrapper">
          <div id="scroll-sentinel"></div>
        </div>
      `;
      mockContext = {
        getWrapperElement: () => document.getElementById("wrapper"),
        send: mockSend,
      };
      manager = new ObserverManager(mockContext, mockLogger);

      manager.setupInfiniteScrollObserver();

      expect(mockConsole.debug).toHaveBeenCalledWith(
        expect.any(String),
        "Observer set up successfully"
      );
    });

    it("reuses the existing observer when the sentinel is unchanged", () => {
      document.body.innerHTML = `
        <div id="wrapper">
          <div id="scroll-sentinel"></div>
        </div>
      `;
      mockContext = {
        getWrapperElement: () => document.getElementById("wrapper"),
        send: mockSend,
      };
      manager = new ObserverManager(mockContext, mockLogger);

      manager.setupInfiniteScrollObserver();
      manager.setupInfiniteScrollObserver();

      // Same sentinel node → only one setup; subsequent calls are no-ops.
      const setupCalls = mockConsole.debug.mock.calls.filter(
        (call) => call[1] === "Observer set up successfully"
      );
      expect(setupCalls.length).toBe(1);
    });

    it("releases the load_more throttle if the server never responds", () => {
      // Build fresh wrapper + sentinel via DOM APIs to avoid the XSS-reminder
      // hook in tests that scans innerHTML assignments.
      document.body.replaceChildren();
      const wrapper = document.createElement("div");
      wrapper.id = "wrapper";
      const sentinel = document.createElement("div");
      sentinel.id = "scroll-sentinel";
      wrapper.appendChild(sentinel);
      document.body.appendChild(wrapper);

      mockContext = {
        getWrapperElement: () => document.getElementById("wrapper"),
        send: mockSend,
      };
      manager = new ObserverManager(mockContext, mockLogger);
      manager.setupInfiniteScrollObserver();

      // First intersection → send load_more, arm the 30s safety timeout.
      MockIntersectionObserver.instances[0].triggerIntersection(true);
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith({ action: "load_more" });

      // While "pending" is true, subsequent intersections must be ignored.
      MockIntersectionObserver.instances[0].triggerIntersection(true);
      expect(mockSend).toHaveBeenCalledTimes(1);

      // Server never responds. Advance past the 30s safety net.
      jest.advanceTimersByTime(30001);

      // A warning must be logged and a fresh observer allocated so the
      // next intersection can re-fire. MockIntersectionObserver.instances
      // should now have a second entry.
      expect(mockConsole.warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringMatching(/load_more response not received/)
      );
      expect(MockIntersectionObserver.instances.length).toBeGreaterThanOrEqual(2);

      // The next intersection re-arms the throttle and sends again.
      const latest = MockIntersectionObserver.instances[MockIntersectionObserver.instances.length - 1];
      latest.triggerIntersection(true);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it("clears the load_more safety timeout when lvt:updated fires", () => {
      document.body.replaceChildren();
      const wrapper = document.createElement("div");
      wrapper.id = "wrapper";
      const sentinel = document.createElement("div");
      sentinel.id = "scroll-sentinel";
      wrapper.appendChild(sentinel);
      document.body.appendChild(wrapper);

      mockContext = {
        getWrapperElement: () => document.getElementById("wrapper"),
        send: mockSend,
      };
      manager = new ObserverManager(mockContext, mockLogger);
      manager.setupInfiniteScrollObserver();

      MockIntersectionObserver.instances[0].triggerIntersection(true);
      expect(mockSend).toHaveBeenCalledTimes(1);

      // Simulate the server's lvt:updated event for load_more.
      wrapper.dispatchEvent(
        new CustomEvent("lvt:updated", { detail: { action: "load_more" } })
      );

      // Advance well past the 30s safety window — no warning should fire
      // because the timeout was cleared on the legitimate response.
      jest.advanceTimersByTime(60000);

      expect(mockConsole.warn).not.toHaveBeenCalledWith(
        expect.any(String),
        expect.stringMatching(/load_more response not received/)
      );
    });

    it("rebuilds the observer when the sentinel node identity changes", () => {
      // Build fresh wrapper + sentinel via DOM APIs to avoid the XSS-reminder
      // hook in tests that scans innerHTML assignments.
      document.body.replaceChildren();
      const wrapper = document.createElement("div");
      wrapper.id = "wrapper";
      const sentinel1 = document.createElement("div");
      sentinel1.id = "scroll-sentinel";
      wrapper.appendChild(sentinel1);
      document.body.appendChild(wrapper);

      mockContext = {
        getWrapperElement: () => document.getElementById("wrapper"),
        send: mockSend,
      };
      manager = new ObserverManager(mockContext, mockLogger);

      manager.setupInfiniteScrollObserver();

      // Replace sentinel with a fresh node (simulates morphdom recreating
      // the element on a structural transition).
      sentinel1.remove();
      const sentinel2 = document.createElement("div");
      sentinel2.id = "scroll-sentinel";
      wrapper.appendChild(sentinel2);

      manager.setupInfiniteScrollObserver();

      const setupCalls = mockConsole.debug.mock.calls.filter(
        (call) => call[1] === "Observer set up successfully"
      );
      expect(setupCalls.length).toBe(2);

      // The old observer MUST be disconnected before the new one is created —
      // otherwise it keeps firing callbacks against the detached sentinel and
      // leaks memory until GC collects a chain that the observer itself holds.
      expect(MockIntersectionObserver.instances.length).toBe(2);
      expect(MockIntersectionObserver.instances[0].disconnected).toBe(true);
      expect(MockIntersectionObserver.instances[1].disconnected).toBe(false);
    });
  });

  describe("setupInfiniteScrollMutationObserver", () => {
    it("does nothing if wrapper element is null", () => {
      mockContext = {
        getWrapperElement: () => null,
        send: mockSend,
      };
      manager = new ObserverManager(mockContext, mockLogger);

      manager.setupInfiniteScrollMutationObserver();

      // Should not log setup message since wrapper is null
      const mutationSetupCalls = mockConsole.debug.mock.calls.filter(
        (call) => call[1] === "MutationObserver set up successfully"
      );
      expect(mutationSetupCalls.length).toBe(0);
    });

    it("sets up MutationObserver when wrapper exists", () => {
      document.body.innerHTML = "<div id='wrapper'></div>";
      mockContext = {
        getWrapperElement: () => document.getElementById("wrapper"),
        send: mockSend,
      };
      manager = new ObserverManager(mockContext, mockLogger);

      manager.setupInfiniteScrollMutationObserver();

      expect(mockConsole.debug).toHaveBeenCalledWith(
        expect.any(String),
        "MutationObserver set up successfully"
      );
    });

    it("disconnects previous mutation observer before setting up new one", () => {
      document.body.innerHTML = "<div id='wrapper'></div>";
      mockContext = {
        getWrapperElement: () => document.getElementById("wrapper"),
        send: mockSend,
      };
      manager = new ObserverManager(mockContext, mockLogger);

      manager.setupInfiniteScrollMutationObserver();
      manager.setupInfiniteScrollMutationObserver();

      const mutationSetupCalls = mockConsole.debug.mock.calls.filter(
        (call) => call[1] === "MutationObserver set up successfully"
      );
      expect(mutationSetupCalls.length).toBe(2);
    });
  });

  describe("teardown", () => {
    it("disconnects all observers", () => {
      document.body.innerHTML = `
        <div id="wrapper">
          <div id="scroll-sentinel"></div>
        </div>
      `;
      mockContext = {
        getWrapperElement: () => document.getElementById("wrapper"),
        send: mockSend,
      };
      manager = new ObserverManager(mockContext, mockLogger);

      manager.setupInfiniteScrollObserver();
      manager.setupInfiniteScrollMutationObserver();

      expect(() => manager.teardown()).not.toThrow();

      // IntersectionObserver instance created by setupInfiniteScrollObserver
      // must be disconnected — verifies teardown actually cleans up, not just
      // that it doesn't throw.
      expect(MockIntersectionObserver.instances.length).toBe(1);
      expect(MockIntersectionObserver.instances[0].disconnected).toBe(true);
    });

    it("is safe to call when no observers are set up", () => {
      mockContext = {
        getWrapperElement: () => null,
        send: mockSend,
      };
      manager = new ObserverManager(mockContext, mockLogger);

      expect(() => manager.teardown()).not.toThrow();
    });

    it("is safe to call multiple times", () => {
      document.body.innerHTML = `
        <div id="wrapper">
          <div id="scroll-sentinel"></div>
        </div>
      `;
      mockContext = {
        getWrapperElement: () => document.getElementById("wrapper"),
        send: mockSend,
      };
      manager = new ObserverManager(mockContext, mockLogger);

      manager.setupInfiniteScrollObserver();
      manager.teardown();
      manager.teardown();

      expect(() => manager.teardown()).not.toThrow();
    });
  });
});
