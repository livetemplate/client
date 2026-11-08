/**
 * A client connect() that succeeds over a mocked WebSocket: the HEAD probe
 * reports WebSocket support, and the test opens the socket by hand.
 *
 * Same shape as the inline harness in upload-ssr-binding.test.ts (issue #453);
 * new connect-path tests import this rather than copying it again.
 */

export class MockWebSocket {
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

  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
  }

  send(data: string) {
    this.sent.push(data);
  }

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
}

export let mockSockets: MockWebSocket[] = [];

export function installMockWebSocket() {
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

export function installFetchStub() {
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
