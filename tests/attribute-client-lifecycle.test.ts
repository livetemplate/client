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
});
