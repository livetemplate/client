import { LiveTemplateClient } from "../livetemplate-client";

// V14 (client logic leg) — the topic_forbidden error envelope the livetemplate
// server emits on an ACL-denied Subscribe in the WS-connect Mount must surface
// as an `lvt:error` CustomEvent { code, topic } on the wrapper, WITHOUT
// touching the diff/update path. The server keeps the socket open after
// emitting it (livetemplate Phase 4 / V14), so there is no disconnect to
// handle here. The envelope shape asserted below is byte-for-byte the
// server-emitted contract (livetemplate topic_runtime.go topicErrorEnvelope).
describe("handleWebSocketPayload — topic error envelope (V14)", () => {
  let client: LiveTemplateClient;
  let wrapper: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = ""; // safe: test cleanup, matches existing pattern
    wrapper = document.createElement("div");
    wrapper.setAttribute("data-lvt-id", "lvt-v14");
    wrapper.appendChild(document.createTextNode("original"));
    document.body.appendChild(wrapper);

    client = new LiveTemplateClient();
    (client as any).wrapperElement = wrapper;
  });

  afterEach(() => {
    document.body.innerHTML = ""; // safe: test cleanup
  });

  const feed = (payload: unknown) =>
    (client as any).handleWebSocketPayload(payload);

  describe("topic_forbidden envelope", () => {
    it("dispatches lvt:error on the wrapper with the exact { code, topic } detail", () => {
      const events: CustomEvent[] = [];
      wrapper.addEventListener("lvt:error", (e) =>
        events.push(e as CustomEvent)
      );

      // V14's spec scenario: WithTopicACL denies "private/admin".
      feed({ type: "error", code: "topic_forbidden", topic: "private/admin" });

      expect(events).toHaveLength(1);
      expect(events[0].detail).toEqual({
        code: "topic_forbidden",
        topic: "private/admin",
      });
    });

    it("dispatches on the wrapper only — non-bubbling, not visible at document", () => {
      const onWrapper = jest.fn();
      const onDocument = jest.fn();
      wrapper.addEventListener("lvt:error", onWrapper);
      document.addEventListener("lvt:error", onDocument);

      feed({ type: "error", code: "topic_forbidden", topic: "private/admin" });

      expect(onWrapper).toHaveBeenCalledTimes(1);
      // CustomEvent defaults to bubbles:false — a document-level listener must
      // NOT see it. This is also what keeps it distinct from the form-level
      // `lvt:error` (state/form-lifecycle-manager.ts), a different event on a
      // different target with a ResponseMetadata detail.
      expect(onDocument).not.toHaveBeenCalled();

      document.removeEventListener("lvt:error", onDocument);
    });

    it("does NOT enter the diff path (no updateDOM, no lvt:updated, DOM untouched)", () => {
      const updateDOMSpy = jest.spyOn(client as any, "updateDOM");
      const updated = jest.fn();
      wrapper.addEventListener("lvt:updated", updated);

      feed({ type: "error", code: "topic_forbidden", topic: "private/admin" });

      expect(updateDOMSpy).not.toHaveBeenCalled();
      expect(updated).not.toHaveBeenCalled();
      expect(wrapper.textContent).toBe("original");

      updateDOMSpy.mockRestore();
    });
  });

  describe("the new branch does not over-match", () => {
    it("a normal UpdateResponse still flows to the diff path (no lvt:error)", () => {
      (client as any).isInitialized = true; // isolate the diff-path-entry check
      const updateDOMSpy = jest
        .spyOn(client as any, "updateDOM")
        .mockImplementation(() => {});
      const errored = jest.fn();
      wrapper.addEventListener("lvt:error", errored);

      feed({ tree: { s: ["<p>", "</p>"], "0": "hi" }, meta: { success: true } });

      expect(errored).not.toHaveBeenCalled();
      expect(updateDOMSpy).toHaveBeenCalledTimes(1);

      updateDOMSpy.mockRestore();
    });
  });
});
