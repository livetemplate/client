import { ObserverManager, ObserverContext } from "../dom/observer-manager";
import { createLogger } from "../utils/logger";

// Mock IntersectionObserver
class MockIntersectionObserver {
  callback: IntersectionObserverCallback;
  options?: IntersectionObserverInit;
  elements: Element[] = [];

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.options = options;
  }

  observe(element: Element) {
    this.elements.push(element);
  }

  unobserve(element: Element) {
    this.elements = this.elements.filter((e) => e !== element);
  }

  disconnect() {
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
    document.body.innerHTML = "";
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
    if (manager) {
      manager.teardown();
    }
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

    it("disconnects previous observer before setting up new one", () => {
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

      // Should have logged setup twice (once per call)
      const setupCalls = mockConsole.debug.mock.calls.filter(
        (call) => call[1] === "Observer set up successfully"
      );
      expect(setupCalls.length).toBe(2);
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

      // Should not throw
      expect(() => manager.teardown()).not.toThrow();
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
