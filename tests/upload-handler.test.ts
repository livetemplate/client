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
