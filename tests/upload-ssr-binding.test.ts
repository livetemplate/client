import { LiveTemplateClient } from "../livetemplate-client";

// Regression test for issue #453: a file input with lvt-upload that is SSR'd
// (present in the DOM before connect) and never re-rendered with new nodes must
// still get its change handler bound on connect(). Before the fix, the handler
// was bound only from updateDOM's post-render block, which is skipped on a
// hydrate-idempotent first render — so selecting a file sent no upload_start.

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

// Build the wrapper with an SSR'd lvt-upload file input already present, exactly
// as a server would render it before the client connects.
function createSSRWrapper(): HTMLDivElement {
  const wrapper = document.createElement("div");
  wrapper.setAttribute("data-lvt-id", "test-ssr-upload");
  wrapper.innerHTML = `<input type="file" lvt-upload="avatar" id="avatar-input" />`;
  document.body.appendChild(wrapper);
  return wrapper;
}

describe("SSR'd lvt-upload binding on connect (issue #453)", () => {
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
    client = new LiveTemplateClient({ logLevel: "error" });
    const connectPromise = client.connect();
    // Resolve the HEAD fetch that probes for WebSocket support
    await jest.advanceTimersByTimeAsync(0);
    // Open the WebSocket — useHTTP=false, readyState=OPEN
    mockSockets[0]?.simulateOpen();
    await connectPromise;
  }

  it("binds the change handler and sends upload_start on file select", async () => {
    createSSRWrapper();
    await connectClient();

    const input = document.getElementById("avatar-input") as HTMLInputElement;
    const file = new File(["hello"], "avatar.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });

    input.dispatchEvent(new Event("change"));

    const uploadStart = mockSockets[0].sent
      .map((raw) => JSON.parse(raw))
      .find((msg) => msg.action === "upload_start");

    expect(uploadStart).toMatchObject({
      action: "upload_start",
      upload_name: "avatar",
    });
  });
});
