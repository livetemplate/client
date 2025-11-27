import { S3Uploader } from "../upload/s3-uploader";
import type { UploadEntry, ExternalUploadMeta } from "../upload/types";

describe("S3Uploader", () => {
  let uploader: S3Uploader;
  let mockXHR: {
    open: jest.Mock;
    send: jest.Mock;
    setRequestHeader: jest.Mock;
    abort: jest.Mock;
    upload: {
      addEventListener: jest.Mock;
    };
    addEventListener: jest.Mock;
    status: number;
    statusText: string;
  };
  let xhrEventHandlers: Map<string, (event?: any) => void>;
  let uploadEventHandlers: Map<string, (event?: any) => void>;

  beforeEach(() => {
    xhrEventHandlers = new Map();
    uploadEventHandlers = new Map();

    mockXHR = {
      open: jest.fn(),
      send: jest.fn(),
      setRequestHeader: jest.fn(),
      abort: jest.fn(),
      upload: {
        addEventListener: jest.fn((event: string, handler: (event?: any) => void) => {
          uploadEventHandlers.set(event, handler);
        }),
      },
      addEventListener: jest.fn((event: string, handler: (event?: any) => void) => {
        xhrEventHandlers.set(event, handler);
      }),
      status: 200,
      statusText: "OK",
    };

    (global as any).XMLHttpRequest = jest.fn(() => mockXHR);
    uploader = new S3Uploader();
  });

  const createEntry = (overrides: Partial<UploadEntry> = {}): UploadEntry => ({
    id: "test-entry-1",
    file: new File(["test content"], "test.txt", { type: "text/plain" }),
    uploadName: "test-upload",
    progress: 0,
    bytesUploaded: 0,
    valid: true,
    done: false,
    ...overrides,
  });

  const createMeta = (overrides: Partial<ExternalUploadMeta> = {}): ExternalUploadMeta => ({
    uploader: "s3",
    url: "https://s3.example.com/bucket/key?presigned=signature",
    ...overrides,
  });

  describe("upload", () => {
    it("uploads file to presigned URL", async () => {
      const entry = createEntry();
      const meta = createMeta();

      const uploadPromise = uploader.upload(entry, meta);

      expect(mockXHR.open).toHaveBeenCalledWith("PUT", meta.url);
      expect(mockXHR.send).toHaveBeenCalledWith(entry.file);

      // Simulate successful upload
      mockXHR.status = 200;
      xhrEventHandlers.get("load")!();

      await uploadPromise;

      expect(entry.done).toBe(true);
      expect(entry.progress).toBe(100);
    });

    it("sets custom headers", async () => {
      const entry = createEntry();
      const meta = createMeta({
        headers: {
          "Content-Type": "text/plain",
          "x-amz-acl": "public-read",
        },
      });

      const uploadPromise = uploader.upload(entry, meta);

      expect(mockXHR.setRequestHeader).toHaveBeenCalledWith("Content-Type", "text/plain");
      expect(mockXHR.setRequestHeader).toHaveBeenCalledWith("x-amz-acl", "public-read");

      mockXHR.status = 200;
      xhrEventHandlers.get("load")!();
      await uploadPromise;
    });

    it("tracks upload progress", async () => {
      const entry = createEntry();
      const meta = createMeta();
      const onProgress = jest.fn();

      const uploadPromise = uploader.upload(entry, meta, onProgress);

      // Simulate progress event
      uploadEventHandlers.get("progress")!({
        lengthComputable: true,
        loaded: 50,
        total: 100,
      });

      expect(entry.bytesUploaded).toBe(50);
      expect(entry.progress).toBe(50);
      expect(onProgress).toHaveBeenCalledWith(entry);

      // Complete upload
      mockXHR.status = 200;
      xhrEventHandlers.get("load")!();
      await uploadPromise;
    });

    it("handles upload failure with status code", async () => {
      const entry = createEntry();
      const meta = createMeta();

      const uploadPromise = uploader.upload(entry, meta);

      mockXHR.status = 403;
      mockXHR.statusText = "Forbidden";
      xhrEventHandlers.get("load")!();

      await expect(uploadPromise).rejects.toThrow("S3 upload failed with status 403: Forbidden");
      expect(entry.error).toBe("S3 upload failed with status 403: Forbidden");
    });

    it("handles network error", async () => {
      const entry = createEntry();
      const meta = createMeta();

      const uploadPromise = uploader.upload(entry, meta);

      xhrEventHandlers.get("error")!();

      await expect(uploadPromise).rejects.toThrow("S3 upload failed: Network error");
      expect(entry.error).toBe("S3 upload failed: Network error");
    });

    it("supports abort/cancellation", async () => {
      const entry = createEntry();
      const meta = createMeta();

      const uploadPromise = uploader.upload(entry, meta);

      // Abort the upload
      entry.abortController!.abort();

      // The abort event should be triggered
      xhrEventHandlers.get("abort")!();

      await expect(uploadPromise).rejects.toThrow("S3 upload cancelled");
      expect(mockXHR.abort).toHaveBeenCalled();
    });

    it("does not call progress callback for non-computable progress", async () => {
      const entry = createEntry();
      const meta = createMeta();
      const onProgress = jest.fn();

      const uploadPromise = uploader.upload(entry, meta, onProgress);

      // Simulate progress event without length
      uploadEventHandlers.get("progress")!({
        lengthComputable: false,
        loaded: 50,
        total: 0,
      });

      expect(onProgress).not.toHaveBeenCalled();

      mockXHR.status = 200;
      xhrEventHandlers.get("load")!();
      await uploadPromise;
    });
  });
});
