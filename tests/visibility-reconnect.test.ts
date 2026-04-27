import { LiveTemplateClient } from "../livetemplate-client";

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

  constructor(url: string) {
    this.url = url;
  }

  send(_data: string) {}
  close() {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose(new CloseEvent("close", { code: 1000 }));
    }
  }

  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    if (this.onopen) {
      this.onopen(new Event("open"));
    }
  }

  simulateClose() {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose(new CloseEvent("close", { code: 1006 }));
    }
  }
}

let mockSockets: MockWebSocket[] = [];

function installMockWebSocket() {
  mockSockets = [];
  const WS = jest.fn().mockImplementation((url: string) => {
    const sock = new MockWebSocket(url);
    mockSockets.push(sock);
    return sock;
  }) as any;
  WS.CONNECTING = 0;
  WS.OPEN = 1;
  WS.CLOSING = 2;
  WS.CLOSED = 3;
  (global as any).WebSocket = WS;
}

function installFetchStub() {
  if (typeof (globalThis as any).fetch !== "function") {
    (globalThis as any).fetch = () => {};
  }
  jest.spyOn(globalThis as any, "fetch").mockImplementation((...args: unknown[]) => {
    const opts = args[1] as any;
    if (opts?.method === "HEAD") {
      return Promise.resolve(
        new Response(null, {
          status: 200,
          headers: { "X-LiveTemplate-WebSocket": "enabled" },
        })
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
}

function createWrapper(): HTMLDivElement {
  const wrapper = document.createElement("div");
  wrapper.setAttribute("data-lvt-id", "test-visibility");
  document.body.appendChild(wrapper);
  return wrapper;
}

function fireVisibilityChange(hidden: boolean) {
  Object.defineProperty(document, "hidden", {
    value: hidden,
    writable: true,
    configurable: true,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

function firePageShow(persisted: boolean) {
  const event = new PageTransitionEvent("pageshow", { persisted });
  window.dispatchEvent(event);
}

// Simulates a background/foreground cycle with the given elapsed time
function simulateBackground(ms: number) {
  fireVisibilityChange(true);
  jest.advanceTimersByTime(ms);
  fireVisibilityChange(false);
}

describe("Visibility-based reconnection", () => {
  let client: LiveTemplateClient;

  beforeEach(() => {
    jest.useFakeTimers();
    document.body.replaceChildren();
    installMockWebSocket();
    installFetchStub();
    history.replaceState(null, "", "/test");
  });

  afterEach(() => {
    client?.disconnect();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  async function connectClient(): Promise<void> {
    createWrapper();
    client = new LiveTemplateClient({ logLevel: "error" });
    const connectPromise = client.connect();
    // Resolve the HEAD fetch
    await jest.advanceTimersByTimeAsync(0);
    // Open the WebSocket
    mockSockets[0]?.simulateOpen();
    await connectPromise;
  }

  it("reconnects when page becomes visible after >3s with dead WebSocket", async () => {
    await connectClient();
    expect(client.isReady()).toBe(true);

    // Simulate iOS background: WebSocket dies while hidden
    fireVisibilityChange(true);
    jest.advanceTimersByTime(1000);
    mockSockets[0].simulateClose();
    jest.advanceTimersByTime(4000);
    fireVisibilityChange(false);

    // Wait for the 500ms reconnect delay + resolve async connect
    await jest.advanceTimersByTimeAsync(500);
    // Let the HEAD fetch inside performVisibilityReconnect resolve
    await jest.advanceTimersByTimeAsync(0);

    // A new WebSocket should have been created for reconnection
    expect(mockSockets.length).toBe(2);

    // Simulate successful reconnection
    mockSockets[1].simulateOpen();
    await jest.advanceTimersByTimeAsync(0);

    expect(client.isReady()).toBe(true);
  });

  it("does not reconnect on short background (<3s)", async () => {
    await connectClient();
    const initialSocketCount = mockSockets.length;

    // Background for only 2 seconds then WebSocket dies
    fireVisibilityChange(true);
    jest.advanceTimersByTime(500);
    mockSockets[0].simulateClose();
    jest.advanceTimersByTime(1500);
    fireVisibilityChange(false);

    // Wait well past the 500ms delay
    await jest.advanceTimersByTimeAsync(1000);

    // No reconnection attempt — elapsed < 3s
    expect(mockSockets.length).toBe(initialSocketCount);
  });

  it("reconnects even when WebSocket reports OPEN (zombie socket defense)", async () => {
    await connectClient();
    expect(client.isReady()).toBe(true);
    const initialSocketCount = mockSockets.length;

    // Background for 5 seconds — WebSocket stays OPEN (possible zombie)
    simulateBackground(5000);

    // Wait for the 500ms delay + resolve async connect
    await jest.advanceTimersByTimeAsync(500);
    await jest.advanceTimersByTimeAsync(0);

    // Should reconnect regardless of readyState — iOS zombie defense
    expect(mockSockets.length).toBe(initialSocketCount + 1);

    // Complete the reconnection
    mockSockets[mockSockets.length - 1].simulateOpen();
    await jest.advanceTimersByTimeAsync(0);
    expect(client.isReady()).toBe(true);
  });

  it("does not set hiddenAt when no WebSocket transport exists", () => {
    // Unit-level guard test: in HTTP mode (or after disconnect), there
    // is no WebSocket transport, so getReadyState() returns undefined.
    // The visibility handler should not set hiddenAt and therefore
    // never schedule a reconnect. This avoids needing to stand up a
    // full HTTP-mode client with its complex async initialization.
    createWrapper();
    client = new LiveTemplateClient({ logLevel: "error" });

    // Client hasn't connected — no transport exists.
    // Fire visibility events to verify the handler guards work.
    fireVisibilityChange(true);
    fireVisibilityChange(false);

    // With no transport, the hidden handler's readyState check blocks
    // hiddenAt from being set. The visible handler sees hiddenAt === 0
    // and returns early. No setTimeout is scheduled.
    expect(jest.getTimerCount()).toBe(0);
    expect(mockSockets.length).toBe(0);
  });

  it("prevents duplicate concurrent reconnects", async () => {
    await connectClient();
    const initialSocketCount = mockSockets.length;

    // WebSocket dies while connected
    fireVisibilityChange(true);
    jest.advanceTimersByTime(500);
    mockSockets[0].simulateClose();
    jest.advanceTimersByTime(4500);
    fireVisibilityChange(false);

    // Schedule another visibility cycle before first reconnect fires
    // (simulates rapid pageshow + visibilitychange in quick succession)
    firePageShow(true);

    // Wait for both 500ms delays to fire
    await jest.advanceTimersByTimeAsync(600);
    await jest.advanceTimersByTimeAsync(0);

    // Only one reconnection attempt should have been made
    expect(mockSockets.length).toBe(initialSocketCount + 1);
  });

  it("reconnects on pageshow with persisted=true", async () => {
    await connectClient();
    const initialSocketCount = mockSockets.length;

    // Simulate WebSocket dying
    mockSockets[0].simulateClose();

    // Simulate bfcache restore
    firePageShow(true);

    // Wait for the 500ms delay + resolve async
    await jest.advanceTimersByTimeAsync(500);
    await jest.advanceTimersByTimeAsync(0);

    // Should attempt reconnection
    expect(mockSockets.length).toBe(initialSocketCount + 1);
  });

  it("does not reconnect on pageshow with persisted=false", async () => {
    await connectClient();
    const initialSocketCount = mockSockets.length;

    // Simulate WebSocket dying
    mockSockets[0].simulateClose();

    // Normal page load (not from bfcache)
    firePageShow(false);

    await jest.advanceTimersByTimeAsync(500);

    // No reconnection
    expect(mockSockets.length).toBe(initialSocketCount);
  });

  it("removes the old visibility handler on disconnect and re-registers on reconnect", async () => {
    await connectClient();

    const addEventSpy = jest.spyOn(document, "addEventListener");
    const removeEventSpy = jest.spyOn(document, "removeEventListener");

    // disconnect must remove the previously registered handler so that
    // SPAs that build a new client per route don't accumulate listeners
    // holding closures over destroyed instances.
    client.disconnect();
    const removed = removeEventSpy.mock.calls.filter(
      ([event]) => event === "visibilitychange"
    );
    expect(removed.length).toBe(1);

    // The next connect re-attaches a fresh handler — exactly one.
    createWrapper();
    const connectPromise = client.connect();
    await jest.advanceTimersByTimeAsync(0);
    mockSockets[mockSockets.length - 1]?.simulateOpen();
    await connectPromise;

    const added = addEventSpy.mock.calls.filter(
      ([event]) => event === "visibilitychange"
    );
    expect(added.length).toBe(1);

    addEventSpy.mockRestore();
    removeEventSpy.mockRestore();
  });

  it("dispatches lvt:reconnected event on successful reconnect", async () => {
    await connectClient();

    const wrapper = document.querySelector("[data-lvt-id]")!;
    const reconnectedSpy = jest.fn();
    wrapper.addEventListener("lvt:reconnected", reconnectedSpy);

    // Simulate WebSocket dying while backgrounded
    fireVisibilityChange(true);
    jest.advanceTimersByTime(500);
    mockSockets[0].simulateClose();
    jest.advanceTimersByTime(4500);
    fireVisibilityChange(false);

    // Wait for 500ms delay
    await jest.advanceTimersByTimeAsync(500);
    // Resolve the HEAD fetch inside performVisibilityReconnect
    await jest.advanceTimersByTimeAsync(0);

    // Complete the reconnection
    mockSockets[1].simulateOpen();
    // Flush microtasks so performVisibilityReconnect() completes
    await jest.advanceTimersByTimeAsync(0);

    expect(reconnectedSpy).toHaveBeenCalledTimes(1);
  });

  it("does not reconnect after intentional disconnect", async () => {
    await connectClient();

    // hiddenAt is tracked while connected
    fireVisibilityChange(true);
    jest.advanceTimersByTime(1000);

    // Intentional disconnect while hidden
    client.disconnect();

    jest.advanceTimersByTime(4000);
    fireVisibilityChange(false);

    await jest.advanceTimersByTimeAsync(500);

    // hiddenAt was reset by disconnect(), so no reconnection
    const socketsAfterDisconnect = mockSockets.length;
    expect(client.isReady()).toBe(false);
    // No new sockets created — disconnect cleared hiddenAt
    await jest.advanceTimersByTimeAsync(100);
    expect(mockSockets.length).toBe(socketsAfterDisconnect);
  });

  it("cancels a pending reconnect timer when disconnect runs mid-window", async () => {
    await connectClient();
    const initialSocketCount = mockSockets.length;

    // Background long enough to queue a reconnect
    fireVisibilityChange(true);
    jest.advanceTimersByTime(4000);
    fireVisibilityChange(false);
    // 500ms timer is now queued but has not fired yet.

    // disconnect → connect within the timer window. Without timer
    // cancellation, the queued timer fires after the new connect()
    // and triggers an unwanted performVisibilityReconnect() on the
    // freshly connected client.
    client.disconnect();
    createWrapper();
    const connectPromise = client.connect();
    await jest.advanceTimersByTimeAsync(0);
    mockSockets[mockSockets.length - 1]?.simulateOpen();
    await connectPromise;
    const socketsAfterConnect = mockSockets.length;

    // Drain the previously queued 500ms timer — should be a no-op now.
    await jest.advanceTimersByTimeAsync(600);

    // No spurious second WebSocket opened by the cancelled timer.
    expect(mockSockets.length).toBe(socketsAfterConnect);
    // Sanity: the connect itself did open one socket past the initial.
    expect(socketsAfterConnect).toBe(initialSocketCount + 1);
  });
});
