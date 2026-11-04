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
  // The network is down: the open errors, then closes, before it ever opened.
  simulateFail() {
    this.readyState = MockWebSocket.CLOSED;
    this.onerror?.(new Event("error"));
    this.onclose?.(new CloseEvent("close", { code: 1006 }));
  }
  // Deliver a server → client message through the transport's onmessage.
  deliver(obj: unknown) {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(obj) })
    );
  }
}

let mockSockets: MockWebSocket[] = [];
let socketCreatedAt: number[] = [];

function installMockWebSocket() {
  mockSockets = [];
  socketCreatedAt = [];
  const WS = jest.fn().mockImplementation((url: string) => {
    const sock = new MockWebSocket(url);
    mockSockets.push(sock);
    socketCreatedAt.push(Date.now());
    return sock;
  }) as any;
  WS.CONNECTING = 0;
  WS.OPEN = 1;
  WS.CLOSING = 2;
  WS.CLOSED = 3;
  (global as any).WebSocket = WS;
}

// wsHeader is what the HEAD probe reports; flip it to "disabled" to model a
// server that genuinely has no WebSocket.
let wsHeader = "enabled";

function installFetchStub() {
  wsHeader = "enabled";
  if (typeof (globalThis as any).fetch !== "function") {
    (globalThis as any).fetch = () => {};
  }
  jest
    .spyOn(globalThis as any, "fetch")
    .mockImplementation((...args: unknown[]) => {
      const opts = args[1] as any;
      if (opts?.method === "HEAD") {
        // A minimal Response stand-in: jsdom has no global Response, and a
        // throwing stub would make the probe's catch assume WS and never read
        // the header at all.
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: {
            get: (k: string) =>
              k === "X-LiveTemplate-WebSocket" ? wsHeader : null,
          },
        });
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

// Connect a client with an explicit heartbeat interval (set pre-connect, exactly
// as autoInit does from data-lvt-heartbeat-ms; 0 opts OUT, since the heartbeat
// is ON by default) and open its first socket.
async function connectClient(
  heartbeatMs: number
): Promise<{ client: LiveTemplateClient; wrapper: HTMLDivElement }> {
  const wrapper = createWrapper();
  const client = new LiveTemplateClient({ logLevel: "error" });
  (client as any).heartbeatMs = heartbeatMs;
  const p = client.connect();
  await jest.advanceTimersByTimeAsync(0); // resolve HEAD fetch
  mockSockets[0]?.simulateOpen();
  await p;
  return { client, wrapper };
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", {
    value: hidden,
    writable: true,
    configurable: true,
  });
}

function fireVisibilityChange(hidden: boolean) {
  setHidden(hidden);
  document.dispatchEvent(new Event("visibilitychange"));
}

function firePageShow(persisted: boolean) {
  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted }));
}

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

  async function connectWithHeartbeat(enabled: boolean): Promise<void> {
    ({ client } = await connectClient(enabled ? HB : 0));
  }

  function pingsSent(sock: MockWebSocket): number {
    return sock.sent.filter((m) => m.includes("__ping__")).length;
  }

  it("is on by default (no override) and pings at the default interval", async () => {
    createWrapper();
    client = new LiveTemplateClient({ logLevel: "error" });
    const def = (client as any).heartbeatMs;
    expect(def).toBeGreaterThanOrEqual(1000); // default is a real interval, not 0
    const connectPromise = client.connect();
    await jest.advanceTimersByTimeAsync(0);
    mockSockets[0]?.simulateOpen();
    await connectPromise;
    await jest.advanceTimersByTimeAsync(def);
    expect(pingsSent(mockSockets[0])).toBe(1);
  });

  it("sends no ping when opted out (heartbeatMs=0)", async () => {
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

// #160: a RE-connect that fails because the network is down used to latch HTTP
// mode forever — every self-heal path skipped useHTTP, so the page froze until a
// reload. Every assertion counts constructed sockets (an observable retry), so a
// gate that still blocks the lost state fails here rather than passing on a flag.
describe("Lost-socket recovery (#160)", () => {
  let client: LiveTemplateClient;
  let wrapper: HTMLDivElement;

  beforeEach(() => {
    jest.useFakeTimers();
    document.body.replaceChildren();
    installMockWebSocket();
    installFetchStub();
    history.replaceState(null, "", "/test");
    setHidden(false);
  });

  afterEach(() => {
    client?.disconnect();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  async function settle() {
    for (let i = 0; i < 5; i++) await jest.advanceTimersByTimeAsync(0);
  }

  async function connectLive(): Promise<void> {
    ({ client, wrapper } = await connectClient(HB));
  }

  // The live socket dies; the heartbeat's reconnect runs while the network is
  // still down, so its new socket fails → the lost state.
  async function loseSocket(): Promise<void> {
    mockSockets[0].readyState = MockWebSocket.CLOSED;
    await jest.advanceTimersByTimeAsync(HB); // tick → reconnect
    await settle(); // HEAD probe resolves → socket #2 constructed
    expect(mockSockets.length).toBe(2);
    mockSockets[1].simulateFail();
    await settle();
    expect((client as any).useHTTP).toBe(true);
    expect((client as any).wsLost).toBe(true);
  }

  // Lose the socket, then fail the next-tick retry too, so the next timed retry
  // is 2×HB away: inside that window only an event trigger can explain a new
  // socket.
  async function loseSocketAndBurnRetry(): Promise<void> {
    await connectLive();
    await loseSocket();
    await jest.advanceTimersByTimeAsync(HB);
    await settle();
    expect(mockSockets.length).toBe(3);
    mockSockets[2].simulateFail();
    await settle();
  }

  it("retries the socket on the next tick and goes live again", async () => {
    await connectLive();
    await loseSocket();
    const reconnected = jest.fn();
    wrapper.addEventListener("lvt:reconnected", reconnected);

    await jest.advanceTimersByTimeAsync(HB);
    await settle();
    expect(mockSockets.length).toBe(3); // the retry

    mockSockets[2].simulateOpen();
    await settle();
    expect((client as any).useHTTP).toBe(false);
    expect((client as any).wsLost).toBe(false);
    expect(client.isReady()).toBe(true);
    expect(reconnected).toHaveBeenCalled();
  });

  it("backs off timed retries, capped at 5 min, and never stops", async () => {
    await connectLive();
    await loseSocket();
    // Fail every retry for 45 min of fake time (the cap is reached at ~10 min).
    let failed = 2;
    for (let elapsed = 0; elapsed < 45 * 60 * 1000; elapsed += HB) {
      await jest.advanceTimersByTimeAsync(HB);
      await settle();
      while (failed < mockSockets.length) mockSockets[failed++].simulateFail();
      await settle();
    }
    const retries = socketCreatedAt.slice(1); // #2 onward
    const gaps = retries.slice(1).map((t, i) => t - retries[i]);
    expect(gaps.length).toBeGreaterThan(3);
    for (let i = 1; i < gaps.length; i++) {
      expect(gaps[i]).toBeGreaterThanOrEqual(gaps[i - 1]); // non-decreasing
    }
    const cap = 5 * 60 * 1000;
    for (const g of gaps) expect(g).toBeLessThanOrEqual(cap + HB); // tick granularity
    expect(gaps[gaps.length - 1]).toBeGreaterThanOrEqual(cap); // reached the cap
    // Bounded: 45 min is about a dozen attempts, not 270 ticks.
    expect(retries.length).toBeLessThan(20);
  }, 60000);

  it("does not retry a server that reports no WebSocket", async () => {
    await connectLive();
    wsHeader = "disabled";
    mockSockets[0].readyState = MockWebSocket.CLOSED;
    await jest.advanceTimersByTimeAsync(HB);
    await settle();
    expect((client as any).useHTTP).toBe(true);
    expect((client as any).wsLost).toBe(false);
    await jest.advanceTimersByTimeAsync(HB * 20);
    window.dispatchEvent(new Event("online"));
    await jest.advanceTimersByTimeAsync(1000);
    await settle();
    expect(mockSockets.length).toBe(1); // never another socket
  });

  it("keeps a first-connect failure in HTTP mode without retrying", async () => {
    wrapper = createWrapper();
    client = new LiveTemplateClient({ logLevel: "error" });
    (client as any).heartbeatMs = HB;
    const p = client.connect();
    await jest.advanceTimersByTimeAsync(0);
    mockSockets[0].simulateFail();
    await p;
    expect((client as any).useHTTP).toBe(true);
    expect((client as any).wsLost).toBe(false);
    await jest.advanceTimersByTimeAsync(HB * 10);
    window.dispatchEvent(new Event("online"));
    await jest.advanceTimersByTimeAsync(1000);
    await settle();
    expect(mockSockets.length).toBe(1);
  });

  it("retries at once when the network comes back (online)", async () => {
    await loseSocketAndBurnRetry();
    window.dispatchEvent(new Event("online"));
    await jest.advanceTimersByTimeAsync(600); // the 500ms settle delay
    await settle();
    expect(mockSockets.length).toBe(4);
  });

  it("ignores online while the socket is healthy", async () => {
    await connectLive();
    window.dispatchEvent(new Event("online"));
    await jest.advanceTimersByTimeAsync(1000);
    await settle();
    expect(mockSockets.length).toBe(1);
  });

  it("retries on any return to visible, even under 3s", async () => {
    await loseSocketAndBurnRetry();
    fireVisibilityChange(true);
    await jest.advanceTimersByTimeAsync(1000); // well under 3s
    fireVisibilityChange(false);
    await jest.advanceTimersByTimeAsync(600);
    await settle();
    expect(mockSockets.length).toBe(4);
  });

  it("retries on a bfcache pageshow", async () => {
    await loseSocketAndBurnRetry();
    firePageShow(true);
    await jest.advanceTimersByTimeAsync(600);
    await settle();
    expect(mockSockets.length).toBe(4);
  });

  it("coalesces simultaneous triggers into one attempt", async () => {
    await loseSocketAndBurnRetry();
    window.dispatchEvent(new Event("online"));
    firePageShow(true);
    fireVisibilityChange(false);
    await jest.advanceTimersByTimeAsync(600);
    await settle();
    expect(mockSockets.length).toBe(4); // one, not three
  });

  it("disconnect() clears the lost state and the online listener", async () => {
    await connectLive();
    await loseSocket();
    client.disconnect();
    expect((client as any).wsLost).toBe(false);
    window.dispatchEvent(new Event("online"));
    await jest.advanceTimersByTimeAsync(HB * 3);
    await settle();
    expect(mockSockets.length).toBe(2);
  });
});
