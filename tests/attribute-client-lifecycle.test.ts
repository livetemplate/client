import { LiveTemplateClient } from "../livetemplate-client";
import { registerAttribute, getRegisteredAttributes } from "../attribute-registry";
import { __resetCensusForTesting } from "../attribute-census";
import { installFetchStub, installMockWebSocket, mockSockets } from "./helpers/mock-connect";

// Client-level wiring for livetemplate#473 Phase 3: the connect pass and the
// meta.attributes census run inside LiveTemplateClient, not only in the
// registry functions the unit suites call directly.

describe("LiveTemplateClient attribute lifecycle", () => {
  let client: LiveTemplateClient;
  let warn: jest.SpyInstance;
  let registeredBefore: number;

  beforeEach(() => {
    jest.useFakeTimers();
    document.body.replaceChildren();
    installMockWebSocket();
    installFetchStub();
    history.replaceState(null, "", "/test");
    __resetCensusForTesting();
    registeredBefore = getRegisteredAttributes().length;
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    client?.disconnect();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  async function connectClient(): Promise<void> {
    client = new LiveTemplateClient({ logLevel: "error" });
    const connectPromise = client.connect();
    await jest.advanceTimersByTimeAsync(0);
    mockSockets[0]?.simulateOpen();
    await connectPromise;
  }

  function ssrWrapper(html: string): HTMLDivElement {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-lvt-id", "test-attr-lifecycle");
    wrapper.innerHTML = html;
    document.body.appendChild(wrapper);
    return wrapper;
  }

  it("arms a handler registered before connect on SSR'd markup, with no render", async () => {
    const added = jest.fn();
    registerAttribute({ attribute: "lvt-x:ssr-copy", onElementAdded: added });
    ssrWrapper(`<button lvt-x:ssr-copy="https://example.com">Copy</button>`);
    await connectClient();
    expect(added).toHaveBeenCalledTimes(1);
    expect(getRegisteredAttributes().length).toBe(registeredBefore + 1);
  });

  it("warns once for an unclaimed attribute in the initial meta.attributes, not for core ones", async () => {
    const wrapper = ssrWrapper(`<p>hi</p>`);
    await connectClient();
    (client as any).wrapperElement = wrapper;
    (client as any).handleWebSocketPayload({
      tree: { s: ["<p>hi</p>"] },
      meta: {
        success: true,
        errors: {},
        attributes: ["lvt-el:addClass", "lvt-on:click", "lvt-upload", "lvt-x:nope"],
      },
    });
    const census = warn.mock.calls.map((a) => a.join(" ")).filter((m) => m.includes("no attribute handler"));
    expect(census).toHaveLength(1);
    expect(census[0]).toContain("lvt-x:nope");
  });

  it("routes a type registered after connect, without double-binding the built-in listeners", async () => {
    ssrWrapper(
      `<button id="b" lvt-on:click="Clicked">b</button>` +
        `<my-widget id="w" lvt-on:my-late-event="Changed"></my-widget>`
    );
    await connectClient();
    const socket = mockSockets[0];
    const actions = () =>
      socket.sent.map((m) => JSON.parse(m).action).filter((a: string) => a === "Clicked" || a === "Changed");
    const fire = () =>
      document.getElementById("w")!.dispatchEvent(new CustomEvent("my-late-event", { bubbles: true }));

    fire();
    expect(actions()).toEqual([]);

    registerAttribute({
      name: "late-widget",
      selectors: ["my-widget"],
      delegatedEvents: ["my-late-event"],
      setup: () => {},
    });
    fire();
    document.getElementById("b")!.click();
    expect(actions()).toEqual(["Changed", "Clicked"]);
  });

  describe("before the transport is chosen", () => {
    // A page is interactive as soon as its SSR'd markup paints, which on a
    // remote site is well before the WebSocket handshake finishes. A click in
    // that window must not be lost, and must not race the WS mount over HTTP.
    // The registry is module-global, so each test registers its own name.
    function registerRating(attribute: string): jest.Mock {
      const added = jest.fn();
      registerAttribute({
        attribute,
        needsServerChannel: true,
        onElementAdded(el, ctx) {
          added();
          el.addEventListener("click", () => ctx.send?.({ action: ctx.value, data: { stars: 3 } }), {
            signal: ctx.signal,
          });
        },
      });
      return added;
    }
    const posts = () =>
      (globalThis.fetch as unknown as jest.Mock).mock.calls.filter((c) => (c[1] as any)?.method === "POST");

    it("arms handlers while the socket is connecting and sends the click once it opens", async () => {
      const added = registerRating("lvt-x:early-ws");
      ssrWrapper(`<button id="r" lvt-x:early-ws="SetRating">3</button>`);
      client = new LiveTemplateClient({ logLevel: "error" });
      const connectPromise = client.connect();

      document.getElementById("r")!.click(); // before the HEAD probe resolves
      await jest.advanceTimersByTimeAsync(0);
      const socket = mockSockets[0];
      expect(socket.readyState).toBe(0);
      document.getElementById("r")!.click(); // while the socket is CONNECTING

      expect(added).toHaveBeenCalledTimes(1);
      expect(socket.sent).toEqual([]);
      expect(posts()).toEqual([]);

      socket.simulateOpen();
      await connectPromise;
      expect(socket.sent.map((m) => JSON.parse(m))).toEqual([
        { action: "SetRating", data: { stars: 3 } },
        { action: "SetRating", data: { stars: 3 } },
      ]);
      expect(posts()).toEqual([]);
    });

    it("drops a queued click, with a warning, when connect() fails", async () => {
      registerRating("lvt-x:early-fail");
      ssrWrapper(`<button id="r" lvt-x:early-fail="SetRating">3</button>`);
      client = new LiveTemplateClient({ logLevel: "error" });
      jest.spyOn((client as any).webSocketManager, "connect").mockRejectedValue(new Error("boom"));
      const loggerWarn = jest.spyOn((client as any).logger, "warn");
      const connectPromise = client.connect();
      document.getElementById("r")!.click();
      await expect(connectPromise).rejects.toThrow("boom");
      expect(loggerWarn.mock.calls.map((c) => String(c[0]))).toContainEqual(
        expect.stringContaining("dropping 1 message(s)")
      );
      expect((client as any).pendingSends).toBeNull();
      expect(posts()).toEqual([]);
    });

    it("sends nothing and sets nothing up when disconnect() runs mid-connect", async () => {
      registerRating("lvt-x:early-torn");
      ssrWrapper(`<button id="r" lvt-x:early-torn="SetRating">3</button>`);
      client = new LiveTemplateClient({ logLevel: "error" });
      const postHandshakeSetup = jest.spyOn((client as any).eventDelegator, "setupDOMEventTriggerDelegation");
      let finish!: (v: unknown) => void;
      jest
        .spyOn((client as any).webSocketManager, "connect")
        .mockReturnValue(new Promise((resolve) => (finish = resolve)));
      const connectPromise = client.connect();
      document.getElementById("r")!.click();
      client.disconnect();
      finish({ usingWebSocket: true });
      await connectPromise;
      expect(posts()).toEqual([]);
      expect(postHandshakeSetup).not.toHaveBeenCalled();
    });

    it("still sends a queued click when a setup step after the handshake throws", async () => {
      registerRating("lvt-x:early-setup");
      ssrWrapper(`<button id="r" lvt-x:early-setup="SetRating">3</button>`);
      client = new LiveTemplateClient({ logLevel: "error" });
      jest.spyOn((client as any).eventDelegator, "setupDOMEventTriggerDelegation").mockImplementation(() => {
        throw new Error("setup broke");
      });
      const connectPromise = client.connect();
      document.getElementById("r")!.click();
      await jest.advanceTimersByTimeAsync(0);
      mockSockets[0].simulateOpen();
      await expect(connectPromise).rejects.toThrow("setup broke");
      expect((client as any).pendingSends).toBeNull();
      expect(mockSockets[0].sent.map((m) => JSON.parse(m).action)).toEqual(["SetRating"]);
    });

    it("sends an early click over HTTP when the server has no WebSocket", async () => {
      const button = `<button id="r" lvt-x:early-http="SetRating">3</button>`;
      const initialState = { tree: { s: [button] }, meta: { success: true, errors: {} } };
      // Plain stand-ins, as in heartbeat.test.ts: jsdom has no usable Response.
      (globalThis.fetch as unknown as jest.Mock).mockImplementation((...args: unknown[]) => {
        const opts = args[1] as any;
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: (k: string) => (opts?.method === "HEAD" && k === "X-LiveTemplate-WebSocket" ? "disabled" : null) },
          json: () => Promise.resolve(initialState),
          text: () => Promise.resolve(JSON.stringify(initialState)),
        });
      });
      const added = registerRating("lvt-x:early-http");
      ssrWrapper(button);
      client = new LiveTemplateClient({ logLevel: "error" });
      const connectPromise = client.connect();
      document.getElementById("r")!.click();
      expect(posts()).toEqual([]);

      let settled = false;
      connectPromise.then(() => (settled = true));
      for (let i = 0; i < 20 && !settled; i++) await jest.advanceTimersByTimeAsync(10);
      expect(settled).toBe(true);
      expect(mockSockets).toHaveLength(0);
      expect(posts()).toHaveLength(1);
      expect(JSON.parse((posts()[0][1] as any).body)).toEqual({ action: "SetRating", data: { stars: 3 } });
      // The initial state renders the same button over the armed one: the
      // morph keeps the element, so it stays armed once.
      expect(added).toHaveBeenCalledTimes(1);
    });

    it("queues a built-in lvt-on:click made while the socket is connecting", async () => {
      ssrWrapper(`<button id="b" lvt-on:click="Inc">+</button>`);
      client = new LiveTemplateClient({ logLevel: "error" });
      const connectPromise = client.connect();
      document.getElementById("b")!.click();
      await jest.advanceTimersByTimeAsync(0);
      const socket = mockSockets[0];
      expect(socket.sent).toEqual([]);
      socket.simulateOpen();
      await connectPromise;
      expect(socket.sent.map((m) => JSON.parse(m).action)).toEqual(["Inc"]);
      expect(posts()).toEqual([]);
    });

    // A native submit reaches the server even if the socket never opens; a
    // queued one is dropped when connect() fails.
    it("leaves a form submit to the browser until the first transport is chosen", async () => {
      ssrWrapper(`<form id="f" lvt-on:submit="Save"><input name="title" value="a"></form>`);
      const submit = () => {
        const event = new Event("submit", { bubbles: true, cancelable: true });
        document.getElementById("f")!.dispatchEvent(event);
        return event.defaultPrevented;
      };
      client = new LiveTemplateClient({ logLevel: "error" });
      const connectPromise = client.connect();
      expect(submit()).toBe(false);
      await jest.advanceTimersByTimeAsync(0);
      const socket = mockSockets[0];
      expect(submit()).toBe(false);
      socket.simulateOpen();
      await connectPromise;
      expect(socket.sent).toEqual([]);

      expect(submit()).toBe(true);
      expect(socket.sent.map((m) => JSON.parse(m).action)).toEqual(["Save"]);
    });

    it("keeps intercepting form submits during a later connect()", async () => {
      ssrWrapper(`<form id="f" lvt-on:submit="Save"><input name="title" value="a"></form>`);
      await connectClient();
      const again = client.connect();
      const event = new Event("submit", { bubbles: true, cancelable: true });
      document.getElementById("f")!.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      await jest.advanceTimersByTimeAsync(0);
      mockSockets[1].simulateOpen();
      await again;
      expect(mockSockets[1].sent.map((m) => JSON.parse(m).action)).toEqual(["Save"]);
    });
  });
});
