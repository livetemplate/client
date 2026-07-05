import { LiveTemplateClient } from "../livetemplate-client";

// Liveness heartbeat tests. The heartbeat detects a dead OR zombie socket (one
// that still reports OPEN but whose TCP is gone and fires no close event) by
// sending an app-level {action:"__ping__"} and reconnecting if the {pong:true}
// reply doesn't arrive within the deadline. Mirrors visibility-reconnect.test.ts
// (same MockWebSocket + fake-timer harness).

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState: number = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code: 1000 }));
  }
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }
  // Deliver a server → client message through the transport's onmessage.
  deliver(obj: unknown) {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(obj) })
    );
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
  jest
    .spyOn(globalThis as any, "fetch")
    .mockImplementation((...args: unknown[]) => {
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
  wrapper.setAttribute("data-lvt-id", "test-heartbeat");
  document.body.appendChild(wrapper);
  return wrapper;
}

const HB = 10000; // heartbeat interval; pong deadline = max(2000, HB/2) = 5000

describe("Liveness heartbeat", () => {
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

  // Connect with the heartbeat enabled (heartbeatMs is set pre-connect, exactly
  // as autoInit does from the data-lvt-heartbeat-ms attribute).
  async function connectWithHeartbeat(enabled: boolean): Promise<void> {
    createWrapper();
    client = new LiveTemplateClient({ logLevel: "error" });
    if (enabled) (client as any).heartbeatMs = HB;
    const connectPromise = client.connect();
    await jest.advanceTimersByTimeAsync(0); // resolve HEAD fetch
    mockSockets[0]?.simulateOpen();
    await connectPromise;
  }

  function pingsSent(sock: MockWebSocket): number {
    return sock.sent.filter((m) => m.includes("__ping__")).length;
  }

  it("sends no ping when not opted in", async () => {
    await connectWithHeartbeat(false);
    await jest.advanceTimersByTimeAsync(HB * 2);
    expect(pingsSent(mockSockets[0])).toBe(0);
    expect(mockSockets.length).toBe(1);
  });

  it("sends a ping each interval when opted in", async () => {
    await connectWithHeartbeat(true);
    await jest.advanceTimersByTimeAsync(HB);
    expect(pingsSent(mockSockets[0])).toBe(1);
    // Answer the pong so the next interval sends again.
    mockSockets[0].deliver({ pong: true });
    await jest.advanceTimersByTimeAsync(HB);
    expect(pingsSent(mockSockets[0])).toBe(2);
  });

  it("stays connected when the pong arrives in time", async () => {
    await connectWithHeartbeat(true);
    await jest.advanceTimersByTimeAsync(HB); // tick → ping + deadline armed
    mockSockets[0].deliver({ pong: true }); // alive
    await jest.advanceTimersByTimeAsync(6000); // past the 5s deadline
    expect(mockSockets.length).toBe(1); // no reconnect
    expect(client.isReady()).toBe(true);
  });

  it("reconnects when the pong never arrives (zombie: OPEN but silent)", async () => {
    await connectWithHeartbeat(true);
    expect(mockSockets.length).toBe(1);

    // Tick fires a ping; the socket stays OPEN (readyState 1) but never replies —
    // the defining zombie case that no close/visibility event would ever catch.
    await jest.advanceTimersByTimeAsync(HB);
    expect(pingsSent(mockSockets[0])).toBe(1);

    // After the pong deadline (5s), the heartbeat declares it dead → reconnect.
    await jest.advanceTimersByTimeAsync(5000);
    await jest.advanceTimersByTimeAsync(0); // resolve reconnect's HEAD fetch
    expect(mockSockets.length).toBe(2);

    // Completing the new socket restores readiness.
    mockSockets[1].simulateOpen();
    await jest.advanceTimersByTimeAsync(0);
    expect(client.isReady()).toBe(true);
  });

  it("reconnects when the socket is CLOSED at tick time", async () => {
    await connectWithHeartbeat(true);
    // Socket dies but (in this path) we only notice at the next heartbeat tick.
    mockSockets[0].readyState = MockWebSocket.CLOSED;
    await jest.advanceTimersByTimeAsync(HB);
    await jest.advanceTimersByTimeAsync(0); // resolve reconnect
    expect(mockSockets.length).toBe(2);
  });

  it("stops the heartbeat on disconnect (no pings after teardown)", async () => {
    await connectWithHeartbeat(true);
    const sock = mockSockets[0];
    client.disconnect();
    await jest.advanceTimersByTimeAsync(HB * 2);
    expect(pingsSent(sock)).toBe(0);
    expect(mockSockets.length).toBe(1);
  });
});
