import { UploadHandler } from "../upload/upload-handler";
import type { UploadEntry, UploadStartResponse } from "../upload/types";

// Mock FileReader to simulate async file reading behavior.
// The UploadHandler uses FileReader.readAsDataURL() to convert file chunks
// to base64 for WebSocket transmission. This mock returns a fixed base64 string
// after a 0ms timeout to simulate the async nature of the real FileReader API.
class MockFileReader {
  onload: (() => void) | null = null;
  onerror: ((error: Error) => void) | null = null;
  result: string = "";

  readAsDataURL(blob: Blob) {
    setTimeout(() => {
      this.result = "data:application/octet-stream;base64,dGVzdCBjb250ZW50";
      if (this.onload) this.onload();
    }, 0);
  }
}

(global as any).FileReader = MockFileReader;

describe("UploadHandler", () => {
  let handler: UploadHandler;
  let mockSendMessage: jest.Mock;

  beforeEach(() => {
    document.body.innerHTML = "";
    mockSendMessage = jest.fn();
    handler = new UploadHandler(mockSendMessage);
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const createMockFile = (name = "test.txt", content = "test content", type = "text/plain"): File => {
    return new File([content], name, { type });
  };

  describe("initializeFileInputs", () => {
    it("detects file inputs with lvt-upload attribute", () => {
      document.body.innerHTML = `
        <input type="file" lvt-upload="avatar" id="avatar-input" />
        <input type="file" id="regular-input" />
      `;

      handler.initializeFileInputs(document.body);

      const avatarInput = document.getElementById("avatar-input") as HTMLInputElement;

      // Create a file and dispatch change event
      const file = createMockFile();
      Object.defineProperty(avatarInput, "files", { value: [file] });

      avatarInput.dispatchEvent(new Event("change"));

      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "upload_start",
          upload_name: "avatar",
        })
      );
    });

    it("removes existing listener before adding new one", () => {
      document.body.innerHTML = `<input type="file" lvt-upload="test" id="test-input" />`;

      handler.initializeFileInputs(document.body);
      handler.initializeFileInputs(document.body);

      const input = document.getElementById("test-input") as HTMLInputElement;
      const file = createMockFile();
      Object.defineProperty(input, "files", { value: [file] });

      input.dispatchEvent(new Event("change"));

      // Should only send one message, not two
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });

    it("does nothing for empty file selection", () => {
      document.body.innerHTML = `<input type="file" lvt-upload="test" id="test-input" />`;

      handler.initializeFileInputs(document.body);

      const input = document.getElementById("test-input") as HTMLInputElement;
      Object.defineProperty(input, "files", { value: [] });

      input.dispatchEvent(new Event("change"));

      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it("ignores inputs without lvt-upload value", () => {
      document.body.innerHTML = `<input type="file" lvt-upload="" id="test-input" />`;

      handler.initializeFileInputs(document.body);

      const input = document.getElementById("test-input") as HTMLInputElement;
      const file = createMockFile();
      Object.defineProperty(input, "files", { value: [file] });

      input.dispatchEvent(new Event("change"));

      expect(mockSendMessage).not.toHaveBeenCalled();
    });
  });

  describe("startUpload", () => {
    it("sends upload_start message with file metadata", async () => {
      const files = [
        createMockFile("doc1.pdf", "content1", "application/pdf"),
        createMockFile("doc2.txt", "content2", "text/plain"),
      ];

      await handler.startUpload("documents", files);

      expect(mockSendMessage).toHaveBeenCalledWith({
        action: "upload_start",
        upload_name: "documents",
        files: [
          { name: "doc1.pdf", type: "application/pdf", size: 8 },
          { name: "doc2.txt", type: "text/plain", size: 8 },
        ],
      });
    });

    it("uses default MIME type for files without type", async () => {
      const file = new File(["content"], "unknown");
      Object.defineProperty(file, "type", { value: "" });

      await handler.startUpload("test", [file]);

      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          files: [expect.objectContaining({ type: "application/octet-stream" })],
        })
      );
    });
  });

  describe("handleUploadStartResponse", () => {
    it("creates upload entries from server response", async () => {
      const file = createMockFile("test.txt");
      await handler.startUpload("test", [file]);

      const response: UploadStartResponse = {
        upload_name: "test",
        entries: [
          {
            entry_id: "entry-1",
            client_name: "test.txt",
            valid: true,
            auto_upload: false,
          },
        ],
      };

      await handler.handleUploadStartResponse(response);

      const entries = handler.getEntries("test");
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe("entry-1");
      expect(entries[0].valid).toBe(true);
    });

    it("handles invalid entries with error callback", async () => {
      const onError = jest.fn();
      handler = new UploadHandler(mockSendMessage, { onError });

      const file = createMockFile("large.zip");
      await handler.startUpload("test", [file]);

      const response: UploadStartResponse = {
        upload_name: "test",
        entries: [
          {
            entry_id: "entry-1",
            client_name: "large.zip",
            valid: false,
            auto_upload: false,
            error: "File too large",
          },
        ],
      };

      await handler.handleUploadStartResponse(response);

      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ id: "entry-1" }),
        "File too large"
      );
    });

    it("starts chunked upload when auto_upload is true", async () => {
      const file = createMockFile("test.txt");
      await handler.startUpload("test", [file]);

      const response: UploadStartResponse = {
        upload_name: "test",
        entries: [
          {
            entry_id: "entry-1",
            client_name: "test.txt",
            valid: true,
            auto_upload: true,
          },
        ],
      };

      await handler.handleUploadStartResponse(response);

      // Wait for async file reading
      await jest.runAllTimersAsync();

      // Should have sent chunk message
      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "upload_chunk",
          entry_id: "entry-1",
        })
      );
    });

    it("posts a multipart upload (not WS chunks) when mode is proxied", async () => {
      const postMultipart = jest.fn().mockResolvedValue(undefined);
      const proxiedHandler = new UploadHandler(mockSendMessage, {
        postMultipartUpload: postMultipart,
      });

      const file = createMockFile("scan.png", "imgdata", "image/png");
      await proxiedHandler.startUpload("doc", [file]);

      const response: UploadStartResponse = {
        upload_name: "doc",
        entries: [
          {
            entry_id: "entry-1",
            client_name: "scan.png",
            valid: true,
            auto_upload: true,
            mode: "proxied",
          },
        ],
      };

      await proxiedHandler.handleUploadStartResponse(response);
      await jest.runAllTimersAsync();

      // Proxied uploads go via a single multipart POST...
      expect(postMultipart).toHaveBeenCalledTimes(1);
      const fd = postMultipart.mock.calls[0][0] as FormData;
      expect(fd.get("lvt-action")).toBe("upload_doc_complete");
      expect(fd.get("doc")).toBeInstanceOf(File);

      // ...and never over the WebSocket chunk transport.
      expect(mockSendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: "upload_chunk" })
      );
    });

    // Fires a proxied auto-upload from the input named "doc" inside the given
    // form markup and returns the FormData that was POSTed.
    const proxiedUploadFormData = async (formHTML: string): Promise<FormData> => {
      const postMultipart = jest.fn().mockResolvedValue(undefined);
      const proxiedHandler = new UploadHandler(mockSendMessage, {
        postMultipartUpload: postMultipart,
      });

      const form = document.createElement("form");
      form.innerHTML = formHTML;
      const input = form.querySelector('input[name="doc"]') as HTMLInputElement;

      const file = createMockFile("scan.png", "imgdata", "image/png");
      await proxiedHandler.startUpload("doc", [file], input);
      await proxiedHandler.handleUploadStartResponse({
        upload_name: "doc",
        entries: [
          {
            entry_id: "entry-1",
            client_name: "scan.png",
            valid: true,
            auto_upload: true,
            mode: "proxied",
          },
        ],
      });
      await jest.runAllTimersAsync();

      return postMultipart.mock.calls[0][0] as FormData;
    };

    it("serializes only the lvt-upload-with fields into a proxied upload, before the file", async () => {
      const fd = await proxiedUploadFormData(
        '<input type="hidden" name="id" value="item-42" lvt-upload-with>' +
          '<input type="hidden" name="csrf" value="tok-abc">' +
          '<input type="text" name="note" value="jotting">' +
          '<input type="password" name="secret" value="hunter2">' +
          '<input type="file" name="other" lvt-upload="other">' +
          '<input type="file" name="doc" lvt-upload="doc">'
      );

      // The marked record id rides along as a value field...
      expect(fd.get("id")).toBe("item-42");
      // ...ordered before the streamed file part, so OnUpload sees it mid-stream.
      const keys = [...fd.keys()];
      expect(keys.indexOf("id")).toBeLessThan(keys.indexOf("doc"));

      // Everything unmarked stays put. This is the assertion the opt-in contract
      // exists for: under the old denylist the csrf token and the note both
      // travelled, and only the password was special-cased out.
      expect(fd.get("csrf")).toBeNull();
      expect(fd.get("note")).toBeNull();
      expect(fd.get("secret")).toBeNull();

      // The streamed file is still the file part; the other file input is not
      // serialized as a value field, and the action is untouched.
      expect(fd.get("doc")).toBeInstanceOf(File);
      expect(fd.get("other")).toBeNull();
      expect(fd.get("lvt-action")).toBe("upload_doc_complete");
    });

    it("sends no form fields at all when a proxied upload's form marks none", async () => {
      const fd = await proxiedUploadFormData(
        '<input type="hidden" name="id" value="item-42">' +
          '<input type="text" name="note" value="jotting">' +
          '<input type="file" name="doc" lvt-upload="doc">'
      );

      // Unmarked is the default, so the POST carries the action and the file and
      // nothing else — no field leaves the page without being asked to.
      expect([...fd.keys()].sort()).toEqual(["doc", "lvt-action"]);
    });

    it("ignores lvt-upload-with on the reserved action and on file inputs", async () => {
      const fd = await proxiedUploadFormData(
        '<input type="hidden" name="lvt-action" value="hijacked" lvt-upload-with>' +
          '<input type="file" name="other" lvt-upload="other" lvt-upload-with>' +
          '<input type="file" name="doc" lvt-upload="doc">'
      );

      // Marking cannot clobber the action the caller set...
      expect(fd.getAll("lvt-action")).toEqual(["upload_doc_complete"]);
      // ...nor smuggle a second file in as a value field.
      expect(fd.get("other")).toBeNull();
    });

    it("opts in a whole radio group when any one member is marked", async () => {
      const fd = await proxiedUploadFormData(
        '<input type="radio" name="kind" value="scan" lvt-upload-with>' +
          '<input type="radio" name="kind" value="photo" checked>' +
          '<input type="checkbox" name="flag" value="on" lvt-upload-with>' +
          '<input type="radio" name="tier" value="gold" checked>' +
          '<input type="file" name="doc" lvt-upload="doc">'
      );

      // Marking is by name, so the checked sibling travels even though the mark
      // sits on the unchecked one...
      expect(fd.get("kind")).toBe("photo");
      // ...the browser's successful-control rules still decide the value, which
      // is why the marked-but-unchecked box sends nothing...
      expect(fd.get("flag")).toBeNull();
      // ...and an entirely unmarked group stays put, checked or not.
      expect(fd.get("tier")).toBeNull();
    });

    it("re-sends the marked fields with every file of a multi-file selection", async () => {
      const postMultipart = jest.fn().mockResolvedValue(undefined);
      const proxiedHandler = new UploadHandler(mockSendMessage, {
        postMultipartUpload: postMultipart,
      });

      const form = document.createElement("form");
      form.innerHTML =
        '<input type="hidden" name="id" value="item-42" lvt-upload-with>' +
        '<input type="file" name="doc" lvt-upload="doc" multiple>';
      const input = form.querySelector('input[name="doc"]') as HTMLInputElement;

      await proxiedHandler.startUpload(
        "doc",
        [
          createMockFile("one.png", "first", "image/png"),
          createMockFile("two.png", "second", "image/png"),
        ],
        input
      );
      await proxiedHandler.handleUploadStartResponse({
        upload_name: "doc",
        entries: [
          {
            entry_id: "entry-1",
            client_name: "one.png",
            valid: true,
            auto_upload: true,
            mode: "proxied",
          },
          {
            entry_id: "entry-2",
            client_name: "two.png",
            valid: true,
            auto_upload: true,
            mode: "proxied",
          },
        ],
      });
      await jest.runAllTimersAsync();

      // Each file is POSTed separately, and the marked fields ride along with
      // every request — each one reaches OnUpload on its own and has to carry
      // enough context to route its bytes.
      expect(postMultipart).toHaveBeenCalledTimes(2);
      for (const [fd] of postMultipart.mock.calls) {
        expect((fd as FormData).get("id")).toBe("item-42");
      }
    });

    // Fires a chunked (WebSocket) auto-upload from the input named "doc" inside
    // the given form markup and returns whatever console.warn was called with.
    const chunkedUploadWarnings = async (formHTML: string): Promise<string[]> => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      const chunkedHandler = new UploadHandler(mockSendMessage);

      const form = document.createElement("form");
      form.innerHTML = formHTML;
      const input = form.querySelector('input[name="doc"]') as HTMLInputElement;

      await chunkedHandler.startUpload(
        "doc",
        [createMockFile("scan.png", "imgdata", "image/png")],
        input
      );
      await chunkedHandler.handleUploadStartResponse({
        upload_name: "doc",
        entries: [
          {
            entry_id: "entry-1",
            client_name: "scan.png",
            valid: true,
            auto_upload: true,
          },
        ],
      });
      await jest.runAllTimersAsync();

      const messages = warn.mock.calls.map((c) => String(c[0]));
      warn.mockRestore();
      return messages;
    };

    it("warns that marked fields cannot travel on a chunked upload (#508)", async () => {
      const warnings = await chunkedUploadWarnings(
        '<input type="hidden" name="id" value="item-42" lvt-upload-with>' +
          '<input type="file" name="doc" lvt-upload="doc">'
      );

      // The chunked transport carries no form fields, so the mark is silently
      // inert — say so rather than leaving an empty value in the handler with
      // nothing in the markup to explain it.
      const relevant = warnings.filter((m) => m.includes("lvt-upload-with"));
      expect(relevant).toHaveLength(1);
      expect(relevant[0]).toContain("id");
      expect(relevant[0]).toContain("chunked");
    });

    it("stays quiet on a chunked upload when no field is marked", async () => {
      const warnings = await chunkedUploadWarnings(
        '<input type="hidden" name="id" value="item-42">' +
          '<input type="file" name="doc" lvt-upload="doc">'
      );

      // Nothing marked means nothing was promised, so there is nothing to warn
      // about — a warning on every chunked upload would train people to ignore it.
      expect(warnings.filter((m) => m.includes("lvt-upload-with"))).toHaveLength(0);
    });

    it("stays quiet on a proxied upload, where marked fields do travel", async () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      await proxiedUploadFormData(
        '<input type="hidden" name="id" value="item-42" lvt-upload-with>' +
          '<input type="file" name="doc" lvt-upload="doc">'
      );

      // Proxied is always multipart, so the fields arrive and the warning would
      // be plain wrong.
      const messages = warn.mock.calls.map((c) => String(c[0]));
      warn.mockRestore();
      expect(messages.filter((m) => m.includes("lvt-upload-with"))).toHaveLength(0);
    });

    it("warns on a Direct upload, which never carries fields on any path (#508)", async () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      const mockUploader = { upload: jest.fn().mockResolvedValue(undefined) };
      const directHandler = new UploadHandler(mockSendMessage);
      directHandler.registerUploader("mock", mockUploader);

      const form = document.createElement("form");
      form.innerHTML =
        '<input type="hidden" name="id" value="item-42" lvt-upload-with>' +
        '<input type="file" name="doc" lvt-upload="doc">';
      const input = form.querySelector('input[name="doc"]') as HTMLInputElement;

      await directHandler.startUpload(
        "doc",
        [createMockFile("scan.png", "imgdata", "image/png")],
        input
      );
      await directHandler.handleUploadStartResponse({
        upload_name: "doc",
        entries: [
          {
            entry_id: "entry-1",
            client_name: "scan.png",
            valid: true,
            auto_upload: true,
            mode: "direct",
            external: { uploader: "mock", url: "https://cdn.example/scan.png" },
          },
        ],
      });
      await jest.runAllTimersAsync();

      const messages = warn.mock.calls.map((c) => String(c[0]));
      warn.mockRestore();

      // Direct PUTs straight to storage and completes with a metadata-only
      // message, so marked fields reach the handler on NO path — not even with
      // the socket down, which is the multipart fallback Volume gets and Direct
      // does not. The remedy has to differ accordingly.
      const relevant = messages.filter((m) => m.includes("lvt-upload-with"));
      expect(relevant).toHaveLength(1);
      expect(relevant[0]).toContain("direct-to-storage");
      expect(relevant[0]).toContain("controller state");
      expect(relevant[0]).not.toContain("when the socket is down");
    });

    it("previews locally without uploading when mode is preview", async () => {
      const createObjectURL = jest
        .fn()
        .mockReturnValue("blob:mock-url");
      (global as any).URL.createObjectURL = createObjectURL;
      (global as any).URL.revokeObjectURL = jest.fn();

      document.body.innerHTML = `<img data-lvt-upload-preview="draft" />`;

      const postMultipart = jest.fn().mockResolvedValue(undefined);
      const previewHandler = new UploadHandler(mockSendMessage, {
        postMultipartUpload: postMultipart,
      });

      const file = createMockFile("photo.png", "imgdata", "image/png");
      await previewHandler.startUpload("draft", [file]);
      await previewHandler.handleUploadStartResponse({
        upload_name: "draft",
        entries: [
          {
            entry_id: "entry-1",
            client_name: "photo.png",
            valid: true,
            auto_upload: true,
            mode: "preview",
          },
        ],
      });
      await jest.runAllTimersAsync();

      // A local object URL is created and applied to the placeholder...
      expect(createObjectURL).toHaveBeenCalledWith(file);
      const img = document.querySelector(
        '[data-lvt-upload-preview="draft"]'
      ) as HTMLImageElement;
      expect(img.getAttribute("src")).toBe("blob:mock-url");

      // ...and nothing is uploaded (no chunks, no multipart POST).
      expect(postMultipart).not.toHaveBeenCalled();
      expect(mockSendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: "upload_chunk" })
      );
    });

    it("posts the handshake over HTTP when the WebSocket is down", async () => {
      const postUploadStart = jest.fn().mockResolvedValue({
        upload_name: "doc",
        entries: [
          {
            entry_id: "entry-1",
            client_name: "scan.png",
            valid: true,
            auto_upload: true,
            mode: "proxied",
          },
        ],
      });
      const postMultipart = jest.fn().mockResolvedValue(undefined);
      const offlineHandler = new UploadHandler(mockSendMessage, {
        isConnected: () => false,
        postUploadStart,
        postMultipartUpload: postMultipart,
      });

      const file = createMockFile("scan.png", "imgdata", "image/png");
      await offlineHandler.startUpload("doc", [file]);
      await jest.runAllTimersAsync();

      // Handshake went over HTTP (not the WebSocket sendMessage path)...
      expect(postUploadStart).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).not.toHaveBeenCalled();
      // ...and the response was handled inline, dispatching the proxied upload.
      expect(postMultipart).toHaveBeenCalledTimes(1);
    });

    it("completes a disconnected Direct upload over HTTP, re-sending the ref (#448)", async () => {
      const postUploadStart = jest.fn().mockResolvedValue({
        upload_name: "avatar",
        entries: [
          {
            entry_id: "entry-1",
            client_name: "avatar.png",
            valid: true,
            auto_upload: true,
            mode: "direct",
            external: { uploader: "mock", url: "https://cdn.example/avatar.png" },
          },
        ],
      });
      const mockUploader = { upload: jest.fn().mockResolvedValue(undefined) };
      const postUploadComplete = jest.fn().mockResolvedValue(undefined);
      const directHandler = new UploadHandler(mockSendMessage, {
        isConnected: () => false,
        postUploadStart,
        postUploadComplete,
      });
      directHandler.registerUploader("mock", mockUploader);

      const file = createMockFile("avatar.png", "imgdata", "image/png");
      await directHandler.startUpload("avatar", [file]);
      await jest.runAllTimersAsync();

      // The browser PUT ran, then completion went over HTTP carrying the entry
      // metadata + the ref it uploaded to — not the WebSocket entry_ids ack.
      expect(mockUploader.upload).toHaveBeenCalledTimes(1);
      expect(postUploadComplete).toHaveBeenCalledTimes(1);
      const msg = postUploadComplete.mock.calls[0][0];
      expect(msg.upload_name).toBe("avatar");
      expect(msg.entries[0].ref).toBe("https://cdn.example/avatar.png");
      expect(msg.entries[0].client_name).toBe("avatar.png");
      expect(mockSendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: "upload_complete" })
      );
    });

    it("completes Direct on the start-of-upload transport, not a mid-upload reconnect (#448)", async () => {
      let connected = false; // disconnected when the handshake + dispatch run
      const postUploadStart = jest.fn().mockResolvedValue({
        upload_name: "avatar",
        entries: [
          {
            entry_id: "entry-1",
            client_name: "avatar.png",
            valid: true,
            auto_upload: true,
            mode: "direct",
            external: { uploader: "mock", url: "https://cdn.example/avatar.png" },
          },
        ],
      });
      const postUploadComplete = jest.fn().mockResolvedValue(undefined);
      // The slow PUT "reconnects" the socket mid-flight.
      const mockUploader = {
        upload: jest.fn().mockImplementation(async () => {
          connected = true;
        }),
      };
      const directHandler = new UploadHandler(mockSendMessage, {
        isConnected: () => connected,
        postUploadStart,
        postUploadComplete,
      });
      directHandler.registerUploader("mock", mockUploader);

      const file = createMockFile("avatar.png", "imgdata", "image/png");
      await directHandler.startUpload("avatar", [file]);
      await jest.runAllTimersAsync();

      // The transport was snapshotted before the PUT (disconnected), so completion
      // stays on HTTP even though the socket came back up during the upload — the
      // HTTP-start entry only exists in the HTTP completion path.
      expect(postUploadComplete).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: "upload_complete" })
      );
    });

    it("surfaces an error for a disconnected Direct upload with no HTTP completion transport (#448)", async () => {
      const onError = jest.fn();
      const postUploadStart = jest.fn().mockResolvedValue({
        upload_name: "avatar",
        entries: [
          {
            entry_id: "entry-1",
            client_name: "avatar.png",
            valid: true,
            auto_upload: true,
            mode: "direct",
            external: { uploader: "mock", url: "https://cdn.example/avatar.png" },
          },
        ],
      });
      const mockUploader = { upload: jest.fn().mockResolvedValue(undefined) };
      // isConnected:false but no postUploadComplete injected — the completion
      // must not silently fall back to a sendMessage over the dead socket.
      const directHandler = new UploadHandler(mockSendMessage, {
        isConnected: () => false,
        postUploadStart,
        onError,
      });
      directHandler.registerUploader("mock", mockUploader);

      const file = createMockFile("avatar.png", "imgdata", "image/png");
      await directHandler.startUpload("avatar", [file]);
      await jest.runAllTimersAsync();

      expect(mockUploader.upload).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ uploadName: "avatar" }),
        expect.stringContaining("no HTTP transport configured")
      );
      expect(mockSendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: "upload_complete" })
      );
    });

    it("falls back to a multipart POST for a disconnected Volume upload (#449)", async () => {
      const postUploadStart = jest.fn().mockResolvedValue({
        upload_name: "scan",
        entries: [
          {
            entry_id: "entry-1",
            client_name: "scan.png",
            valid: true,
            auto_upload: true,
            mode: "volume",
          },
        ],
      });
      const postMultipart = jest.fn().mockResolvedValue(undefined);
      const volumeHandler = new UploadHandler(mockSendMessage, {
        isConnected: () => false,
        postUploadStart,
        postMultipartUpload: postMultipart,
      });

      const file = createMockFile("scan.png", "imgdata", "image/png");
      await volumeHandler.startUpload("scan", [file]);
      await jest.runAllTimersAsync();

      // The file went as a single multipart POST (server stages it to Dir)...
      expect(postMultipart).toHaveBeenCalledTimes(1);
      const fd = postMultipart.mock.calls[0][0] as FormData;
      expect(fd.get("lvt-action")).toBe("upload_scan_complete");
      expect(fd.get("scan")).toBeInstanceOf(File);
      // ...never over the WebSocket chunk transport.
      expect(mockSendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: "upload_chunk" })
      );
    });

    it("logs warning for missing files", async () => {
      const consoleSpy = jest.spyOn(console, "warn").mockImplementation();

      // Start upload but don't provide matching file
      await handler.startUpload("test", [createMockFile("other.txt")]);

      const response: UploadStartResponse = {
        upload_name: "test",
        entries: [
          {
            entry_id: "entry-1",
            client_name: "missing.txt",
            valid: true,
            auto_upload: false,
          },
        ],
      };

      await handler.handleUploadStartResponse(response);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("No file found for entry")
      );

      consoleSpy.mockRestore();
    });

    it("logs error when no pending files found", async () => {
      const consoleSpy = jest.spyOn(console, "error").mockImplementation();

      const response: UploadStartResponse = {
        upload_name: "unknown",
        entries: [],
      };

      await handler.handleUploadStartResponse(response);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("No pending files found for upload")
      );

      consoleSpy.mockRestore();
    });
  });

  describe("handleProgressMessage", () => {
    it("updates entry progress and calls callback", async () => {
      const onProgress = jest.fn();
      handler = new UploadHandler(mockSendMessage, { onProgress });

      const file = createMockFile("test.txt");
      await handler.startUpload("test", [file]);

      const response: UploadStartResponse = {
        upload_name: "test",
        entries: [
          {
            entry_id: "entry-1",
            client_name: "test.txt",
            valid: true,
            auto_upload: false,
          },
        ],
      };

      await handler.handleUploadStartResponse(response);

      handler.handleProgressMessage({
        type: "upload_progress",
        upload_name: "test",
        entry_id: "entry-1",
        client_name: "test.txt",
        progress: 50,
        bytes_recv: 500,
        bytes_total: 1000,
      });

      const entries = handler.getEntries("test");
      expect(entries[0].progress).toBe(50);
      expect(entries[0].bytesUploaded).toBe(500);
      expect(onProgress).toHaveBeenCalled();
    });

    it("ignores progress for unknown entry", () => {
      const onProgress = jest.fn();
      handler = new UploadHandler(mockSendMessage, { onProgress });

      handler.handleProgressMessage({
        type: "upload_progress",
        upload_name: "test",
        entry_id: "unknown",
        client_name: "unknown.txt",
        progress: 50,
        bytes_recv: 500,
        bytes_total: 1000,
      });

      expect(onProgress).not.toHaveBeenCalled();
    });
  });

  describe("cancelUpload", () => {
    it("cancels upload and sends cancel message", async () => {
      const file = createMockFile("test.txt");
      await handler.startUpload("test", [file]);

      const response: UploadStartResponse = {
        upload_name: "test",
        entries: [
          {
            entry_id: "entry-1",
            client_name: "test.txt",
            valid: true,
            auto_upload: false,
          },
        ],
      };

      await handler.handleUploadStartResponse(response);

      handler.cancelUpload("entry-1");

      expect(mockSendMessage).toHaveBeenCalledWith({
        action: "cancel_upload",
        entry_id: "entry-1",
      });

      const entries = handler.getEntries("test");
      expect(entries).toHaveLength(0);
    });

    it("does nothing for unknown entry", () => {
      handler.cancelUpload("unknown");
      expect(mockSendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: "cancel_upload" })
      );
    });
  });

  describe("triggerPendingUploads", () => {
    it("starts uploads for pending entries", async () => {
      const file = createMockFile("test.txt");
      await handler.startUpload("test", [file]);

      const response: UploadStartResponse = {
        upload_name: "test",
        entries: [
          {
            entry_id: "entry-1",
            client_name: "test.txt",
            valid: true,
            auto_upload: false, // Not auto-uploading
          },
        ],
      };

      await handler.handleUploadStartResponse(response);

      // No chunk sent yet
      expect(mockSendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: "upload_chunk" })
      );

      // Trigger pending uploads
      handler.triggerPendingUploads("test");

      await jest.runAllTimersAsync();

      // Now chunk should be sent
      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "upload_chunk",
          entry_id: "entry-1",
        })
      );
    });
  });

  describe("registerUploader", () => {
    it("registers custom uploader", () => {
      const customUploader = {
        upload: jest.fn().mockResolvedValue(undefined),
      };

      handler.registerUploader("custom", customUploader);

      // Uploader is registered (internal state)
      // Would be used when external upload with uploader: "custom" is received
    });
  });

  describe("getEntries", () => {
    it("returns entries for specified upload name", async () => {
      const file1 = createMockFile("file1.txt");
      const file2 = createMockFile("file2.txt");

      await handler.startUpload("upload1", [file1]);
      await handler.startUpload("upload2", [file2]);

      const response1: UploadStartResponse = {
        upload_name: "upload1",
        entries: [{ entry_id: "e1", client_name: "file1.txt", valid: true, auto_upload: false }],
      };

      const response2: UploadStartResponse = {
        upload_name: "upload2",
        entries: [{ entry_id: "e2", client_name: "file2.txt", valid: true, auto_upload: false }],
      };

      await handler.handleUploadStartResponse(response1);
      await handler.handleUploadStartResponse(response2);

      const entries1 = handler.getEntries("upload1");
      const entries2 = handler.getEntries("upload2");

      expect(entries1).toHaveLength(1);
      expect(entries1[0].id).toBe("e1");

      expect(entries2).toHaveLength(1);
      expect(entries2[0].id).toBe("e2");
    });
  });

  describe("cleanupEntries", () => {
    it("removes completed entries after delay", async () => {
      const file = createMockFile("test.txt");
      await handler.startUpload("test", [file]);

      const response: UploadStartResponse = {
        upload_name: "test",
        entries: [
          { entry_id: "entry-1", client_name: "test.txt", valid: true, auto_upload: false },
        ],
      };

      await handler.handleUploadStartResponse(response);

      // Manually mark entry as done to test cleanup
      const entries = handler.getEntries("test");
      expect(entries).toHaveLength(1);
      entries[0].done = true;

      // Trigger cleanup
      handler.cleanupEntries("test", 1000);

      // Wait for cleanup delay
      jest.advanceTimersByTime(1500);

      const entriesAfterCleanup = handler.getEntries("test");
      expect(entriesAfterCleanup).toHaveLength(0);
    });
  });
});
