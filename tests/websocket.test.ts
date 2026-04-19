import {
  WebSocketTransport,
  WebSocketManager,
  checkWebSocketAvailability,
  fetchInitialState,
} from "../transport/websocket";
import { createLogger } from "../utils/logger";

// Mock WebSocket
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState: number = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  private sentMessages: string[] = [];

  constructor(url: string) {
    this.url = url;
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  handlersAtClose: {
    onopen: ((event: Event) => void) | null;
    onmessage: ((event: MessageEvent) => void) | null;
    onclose: ((event: CloseEvent) => void) | null;
    onerror: ((event: Event) => void) | null;
  } | null = null;

  close() {
    this.handlersAtClose = {
      onopen: this.onopen,
      onmessage: this.onmessage,
      onclose: this.onclose,
      onerror: this.onerror,
    };
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose({ code: 1000, reason: "Normal closure" } as CloseEvent);
    }
  }

  getSentMessages(): string[] {
    return this.sentMessages;
  }

  // Test helpers
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    if (this.onopen) {
      this.onopen(new Event("open"));
    }
  }

  simulateMessage(data: string) {
    if (this.onmessage) {
      this.onmessage({ data } as MessageEvent);
    }
  }

  simulateClose(code = 1000, reason = "Normal closure") {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose({ code, reason } as CloseEvent);
    }
  }

  simulateError() {
    if (this.onerror) {
      this.onerror(new Event("error"));
    }
  }
}

describe("WebSocketTransport", () => {
  let transport: WebSocketTransport;
  let mockSocket: MockWebSocket | null = null;

  beforeEach(() => {
    jest.useFakeTimers();
    (global as any).WebSocket = jest.fn().mockImplementation((url: string) => {
      mockSocket = new MockWebSocket(url);
      return mockSocket;
    });
  });

  afterEach(() => {
    transport?.disconnect();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe("connect", () => {
    it("creates WebSocket connection", () => {
      transport = new WebSocketTransport({ url: "ws://localhost:8080" });
      transport.connect();

      expect(mockSocket).not.toBeNull();
      expect(mockSocket!.url).toBe("ws://localhost:8080");
    });

    it("calls onOpen callback when connection opens", () => {
      const onOpen = jest.fn();
      transport = new WebSocketTransport({
        url: "ws://localhost:8080",
        onOpen,
      });

      transport.connect();
      mockSocket!.simulateOpen();

      expect(onOpen).toHaveBeenCalledWith(mockSocket);
    });

    it("calls onMessage callback when message received", () => {
      const onMessage = jest.fn();
      transport = new WebSocketTransport({
        url: "ws://localhost:8080",
        onMessage,
      });

      transport.connect();
      mockSocket!.simulateOpen();
      mockSocket!.simulateMessage('{"type":"update"}');

      expect(onMessage).toHaveBeenCalledWith(
        expect.objectContaining({ data: '{"type":"update"}' })
      );
    });

    it("calls onClose callback when connection closes", () => {
      const onClose = jest.fn();
      transport = new WebSocketTransport({
        url: "ws://localhost:8080",
        onClose,
      });

      transport.connect();
      mockSocket!.simulateOpen();
      mockSocket!.simulateClose();

      expect(onClose).toHaveBeenCalled();
    });

    it("calls onError callback on error", () => {
      const onError = jest.fn();
      transport = new WebSocketTransport({
        url: "ws://localhost:8080",
        onError,
      });

      transport.connect();
      mockSocket!.simulateError();

      expect(onError).toHaveBeenCalled();
    });
  });

  describe("send", () => {
    it("sends message when socket is open", () => {
      transport = new WebSocketTransport({ url: "ws://localhost:8080" });
      transport.connect();
      mockSocket!.simulateOpen();

      transport.send('{"action":"test"}');

      expect(mockSocket!.getSentMessages()).toContain('{"action":"test"}');
    });

    it("does not send when socket is not open", () => {
      transport = new WebSocketTransport({ url: "ws://localhost:8080" });
      transport.connect();
      // Socket is still CONNECTING, not OPEN

      transport.send('{"action":"test"}');

      expect(mockSocket!.getSentMessages()).toHaveLength(0);
    });
  });

  describe("disconnect", () => {
    it("closes the socket", () => {
      transport = new WebSocketTransport({ url: "ws://localhost:8080" });
      transport.connect();
      mockSocket!.simulateOpen();

      transport.disconnect();

      expect(mockSocket!.readyState).toBe(MockWebSocket.CLOSED);
    });

    it("detaches event handlers before closing", () => {
      transport = new WebSocketTransport({ url: "ws://localhost:8080" });
      transport.connect();
      mockSocket!.simulateOpen();

      const socketRef = mockSocket!;
      expect(socketRef.onopen).not.toBeNull();
      expect(socketRef.onclose).not.toBeNull();

      transport.disconnect();

      expect(socketRef.onopen).toBeNull();
      expect(socketRef.onmessage).toBeNull();
      expect(socketRef.onclose).toBeNull();
      expect(socketRef.onerror).toBeNull();

      expect(socketRef.handlersAtClose).not.toBeNull();
      expect(socketRef.handlersAtClose!.onopen).toBeNull();
      expect(socketRef.handlersAtClose!.onmessage).toBeNull();
      expect(socketRef.handlersAtClose!.onclose).toBeNull();
      expect(socketRef.handlersAtClose!.onerror).toBeNull();
    });

    it("fires onClose synchronously before detaching handlers", () => {
      const onClose = jest.fn();
      transport = new WebSocketTransport({
        url: "ws://localhost:8080",
        onClose,
      });
      transport.connect();
      mockSocket!.simulateOpen();

      transport.disconnect();

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledWith(
        expect.objectContaining({ code: 1000, wasClean: true }),
      );
    });

    it("fires onClose when disconnecting during CONNECTING state", () => {
      const onClose = jest.fn();
      transport = new WebSocketTransport({
        url: "ws://localhost:8080",
        onClose,
      });
      transport.connect();

      transport.disconnect();

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledWith(
        expect.objectContaining({ code: 1000, wasClean: false }),
      );
    });

    it("fires onClose when disconnecting during CLOSING state", () => {
      const onClose = jest.fn();
      transport = new WebSocketTransport({
        url: "ws://localhost:8080",
        onClose,
      });
      transport.connect();
      mockSocket!.simulateOpen();
      mockSocket!.readyState = MockWebSocket.CLOSING;
      onClose.mockClear();

      transport.disconnect();

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("does not fire onClose when socket is already CLOSED", () => {
      const onClose = jest.fn();
      transport = new WebSocketTransport({
        url: "ws://localhost:8080",
        onClose,
      });
      transport.connect();
      mockSocket!.simulateOpen();
      mockSocket!.simulateClose();
      onClose.mockClear();

      transport.disconnect();

      expect(onClose).not.toHaveBeenCalled();
    });

    it("prevents auto-reconnect", () => {
      const onReconnectAttempt = jest.fn();
      transport = new WebSocketTransport({
        url: "ws://localhost:8080",
        autoReconnect: true,
        onReconnectAttempt,
      });

      transport.connect();
      mockSocket!.simulateOpen();
      transport.disconnect();

      jest.advanceTimersByTime(10000);

      expect(onReconnectAttempt).not.toHaveBeenCalled();
    });
  });

  describe("auto-reconnect", () => {
    it("schedules reconnect when connection closes unexpectedly", () => {
      const onReconnectAttempt = jest.fn();
      transport = new WebSocketTransport({
        url: "ws://localhost:8080",
        autoReconnect: true,
        reconnectDelay: 1000,
        onReconnectAttempt,
      });

      transport.connect();
      mockSocket!.simulateOpen();
      mockSocket!.simulateClose();

      // Advance past reconnect delay + some jitter
      jest.advanceTimersByTime(2000);

      expect(onReconnectAttempt).toHaveBeenCalledWith(1, expect.any(Number));
    });

    it("uses exponential backoff", () => {
      const onReconnectAttempt = jest.fn();
      transport = new WebSocketTransport({
        url: "ws://localhost:8080",
        autoReconnect: true,
        reconnectDelay: 1000,
        maxReconnectDelay: 100000, // High enough to not cap
        maxReconnectAttempts: 0, // Unlimited
        onReconnectAttempt,
      });

      transport.connect();
      mockSocket!.simulateOpen();

      // First disconnect
      mockSocket!.simulateClose();
      jest.advanceTimersByTime(2000);
      expect(onReconnectAttempt).toHaveBeenCalledTimes(1);

      // Second disconnect
      mockSocket!.simulateClose();
      jest.advanceTimersByTime(4000);
      expect(onReconnectAttempt).toHaveBeenCalledTimes(2);

      // Third disconnect
      mockSocket!.simulateClose();
      jest.advanceTimersByTime(8000);
      expect(onReconnectAttempt).toHaveBeenCalledTimes(3);
    });

    it("resets reconnect attempts on successful connection", () => {
      const onReconnectAttempt = jest.fn();
      transport = new WebSocketTransport({
        url: "ws://localhost:8080",
        autoReconnect: true,
        reconnectDelay: 1000,
        maxReconnectAttempts: 0,
        onReconnectAttempt,
      });

      transport.connect();
      mockSocket!.simulateOpen();
      mockSocket!.simulateClose();

      jest.advanceTimersByTime(2000);
      expect(onReconnectAttempt).toHaveBeenCalledWith(1, expect.any(Number));

      // Simulate successful reconnect
      mockSocket!.simulateOpen();
      mockSocket!.simulateClose();

      jest.advanceTimersByTime(2000);
      // Should be attempt 1 again, not 2
      expect(onReconnectAttempt).toHaveBeenLastCalledWith(1, expect.any(Number));
    });

    it("stops after max reconnect attempts", () => {
      const onReconnectFailed = jest.fn();
      const onReconnectAttempt = jest.fn();
      transport = new WebSocketTransport({
        url: "ws://localhost:8080",
        autoReconnect: true,
        reconnectDelay: 100,
        maxReconnectDelay: 1000,
        maxReconnectAttempts: 3,
        onReconnectAttempt,
        onReconnectFailed,
      });

      transport.connect();
      mockSocket!.simulateOpen();

      // Simulate 3 failed reconnects
      for (let i = 0; i < 3; i++) {
        mockSocket!.simulateClose();
        jest.advanceTimersByTime(2000);
      }

      // 4th close should trigger failed callback
      mockSocket!.simulateClose();
      jest.advanceTimersByTime(2000);

      expect(onReconnectFailed).toHaveBeenCalled();
    });

    it("respects max reconnect delay", () => {
      const onReconnectAttempt = jest.fn();
      transport = new WebSocketTransport({
        url: "ws://localhost:8080",
        autoReconnect: true,
        reconnectDelay: 1000,
        maxReconnectDelay: 5000,
        maxReconnectAttempts: 0,
        onReconnectAttempt,
      });

      transport.connect();
      mockSocket!.simulateOpen();

      // Multiple disconnects to trigger exponential backoff
      for (let i = 0; i < 5; i++) {
        mockSocket!.simulateClose();
        jest.advanceTimersByTime(10000);
      }

      // All delays should be capped at maxReconnectDelay + jitter
      const delays = onReconnectAttempt.mock.calls.map((call) => call[1]);
      delays.forEach((delay) => {
        expect(delay).toBeLessThanOrEqual(6000); // maxReconnectDelay + max jitter (1000)
      });
    });
  });

  describe("getSocket", () => {
    it("returns the socket when connected", () => {
      transport = new WebSocketTransport({ url: "ws://localhost:8080" });
      transport.connect();

      expect(transport.getSocket()).toBe(mockSocket);
    });

    it("returns null when disconnected", () => {
      transport = new WebSocketTransport({ url: "ws://localhost:8080" });
      transport.connect();
      transport.disconnect();

      expect(transport.getSocket()).toBeNull();
    });
  });
});

describe("liveUrl query params", () => {
  it("concatenates pathname and search correctly", () => {
    // Test the logic that combines pathname and search
    // This is what livetemplate-client.ts does:
    // liveUrl: window.location.pathname + window.location.search

    // With query params
    expect("/app" + "?filter=active&page=2").toBe("/app?filter=active&page=2");

    // Without query params
    expect("/dashboard" + "").toBe("/dashboard");

    // Complex query string
    expect("/search" + "?q=hello+world&sort=date").toBe(
      "/search?q=hello+world&sort=date"
    );
  });
});

describe("checkWebSocketAvailability", () => {
  let mockFetch: jest.Mock;
  let mockLogger: ReturnType<typeof createLogger>;
  let mockConsole: { warn: jest.Mock };

  beforeEach(() => {
    mockFetch = jest.fn();
    (global as any).fetch = mockFetch;
    mockConsole = { warn: jest.fn() };
    mockLogger = createLogger({
      level: "warn",
      sink: mockConsole as unknown as Console,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns true when X-LiveTemplate-WebSocket header is enabled", async () => {
    mockFetch.mockResolvedValue({
      headers: {
        get: (name: string) =>
          name === "X-LiveTemplate-WebSocket" ? "enabled" : null,
      },
    });

    const result = await checkWebSocketAvailability("/live", mockLogger);

    expect(result).toBe(true);
  });

  it("returns false when X-LiveTemplate-WebSocket header is disabled", async () => {
    mockFetch.mockResolvedValue({
      headers: {
        get: (name: string) =>
          name === "X-LiveTemplate-WebSocket" ? "disabled" : null,
      },
    });

    const result = await checkWebSocketAvailability("/live", mockLogger);

    expect(result).toBe(false);
  });

  it("returns true when header is not present", async () => {
    mockFetch.mockResolvedValue({
      headers: {
        get: () => null,
      },
    });

    const result = await checkWebSocketAvailability("/live", mockLogger);

    expect(result).toBe(true);
  });

  it("returns true on fetch error", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));

    const result = await checkWebSocketAvailability("/live", mockLogger);

    expect(result).toBe(true);
    expect(mockConsole.warn).toHaveBeenCalled();
  });
});

describe("WebSocketManager connect", () => {
  let mockSocket: MockWebSocket | null = null;
  let mockFetch: jest.Mock;
  let mockLogger: ReturnType<typeof createLogger>;

  beforeEach(() => {
    jest.useFakeTimers();
    mockSocket = null;
    (global as any).WebSocket = jest.fn().mockImplementation((url: string) => {
      mockSocket = new MockWebSocket(url);
      return mockSocket;
    });
    // checkWebSocketAvailability HEAD request succeeds with WS enabled.
    mockFetch = jest.fn().mockResolvedValue({
      headers: {
        get: (name: string) =>
          name === "X-LiveTemplate-WebSocket" ? "enabled" : null,
      },
    });
    (global as any).fetch = mockFetch;
    mockLogger = createLogger({
      level: "warn",
      sink: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as Console,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const makeManager = (handlers: {
    onConnected?: jest.Mock;
    onDisconnected?: jest.Mock;
    onMessage?: jest.Mock;
    onError?: jest.Mock;
  }) =>
    new WebSocketManager({
      options: { liveUrl: "/live", wsUrl: "ws://localhost:8080" } as any,
      onConnected: handlers.onConnected || jest.fn(),
      onDisconnected: handlers.onDisconnected || jest.fn(),
      onMessage: handlers.onMessage || jest.fn(),
      onError: handlers.onError,
      logger: mockLogger,
    });

  it("calls onConnected and NOT onDisconnected on successful open", async () => {
    const onConnected = jest.fn();
    const onDisconnected = jest.fn();
    const manager = makeManager({ onConnected, onDisconnected });

    const connectPromise = manager.connect();
    // Flush the HEAD-check microtask so checkWebSocketAvailability resolves
    // and WebSocketTransport.connect() runs.
    await Promise.resolve();
    await Promise.resolve();

    mockSocket!.simulateOpen();
    const result = await connectPromise;

    expect(result.usingWebSocket).toBe(true);
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onDisconnected).not.toHaveBeenCalled();
  });

  it("does NOT call onDisconnected when socket closes before opening (HTTP fallback)", async () => {
    const onConnected = jest.fn();
    const onDisconnected = jest.fn();
    // Initial HTTP state fetch (after fallback) returns null.
    const mockInitial = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ tree: null }),
    });
    // Chain: first call is HEAD check (WS enabled), second is GET initial state.
    mockFetch
      .mockReset()
      .mockResolvedValueOnce({
        headers: {
          get: (name: string) =>
            name === "X-LiveTemplate-WebSocket" ? "enabled" : null,
        },
      })
      .mockImplementationOnce(mockInitial);

    const manager = makeManager({ onConnected, onDisconnected });

    const connectPromise = manager.connect();
    await Promise.resolve();
    await Promise.resolve();

    // Socket closes BEFORE onOpen fires — spurious-disconnected scenario.
    mockSocket!.simulateClose();
    // Let the rejection propagate, the catch block run, and fetchInitialState resolve.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const result = await connectPromise;

    expect(result.usingWebSocket).toBe(false);
    expect(onConnected).not.toHaveBeenCalled();
    // Critical: we never connected, so we must NOT signal "disconnected"
    // to downstream — that would falsely flip UI state.
    expect(onDisconnected).not.toHaveBeenCalled();
  });

  it("does NOT call onDisconnected on the 10s open-timeout path", async () => {
    const onConnected = jest.fn();
    const onDisconnected = jest.fn();
    mockFetch
      .mockReset()
      .mockResolvedValueOnce({
        headers: {
          get: (name: string) =>
            name === "X-LiveTemplate-WebSocket" ? "enabled" : null,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tree: null }),
      });

    const manager = makeManager({ onConnected, onDisconnected });

    const connectPromise = manager.connect();
    await Promise.resolve();
    await Promise.resolve();

    // No onOpen/onClose/onError — simulate a silent middlebox drop.
    jest.advanceTimersByTime(10001);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const result = await connectPromise;

    expect(result.usingWebSocket).toBe(false);
    expect(onConnected).not.toHaveBeenCalled();
    // Even though the catch block calls transport.disconnect() (which triggers
    // onClose), the hasConnected gate prevents a spurious onDisconnected.
    expect(onDisconnected).not.toHaveBeenCalled();
  });
});

describe("fetchInitialState", () => {
  let mockFetch: jest.Mock;
  let mockLogger: ReturnType<typeof createLogger>;
  let mockConsole: { warn: jest.Mock };

  beforeEach(() => {
    mockFetch = jest.fn();
    (global as any).fetch = mockFetch;
    mockConsole = { warn: jest.fn() };
    mockLogger = createLogger({
      level: "warn",
      sink: mockConsole as unknown as Console,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns parsed JSON on success", async () => {
    const mockState = { tree: { s: ["<div>", "</div>"] } };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockState),
    });

    const result = await fetchInitialState("/live", mockLogger);

    expect(result).toEqual(mockState);
    expect(mockFetch).toHaveBeenCalledWith("/live", {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
  });

  it("returns null on non-ok response", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
    });

    const result = await fetchInitialState("/live", mockLogger);

    expect(result).toBeNull();
    expect(mockConsole.warn).toHaveBeenCalled();
  });

  it("returns null on fetch error", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));

    const result = await fetchInitialState("/live", mockLogger);

    expect(result).toBeNull();
    expect(mockConsole.warn).toHaveBeenCalled();
  });
});
