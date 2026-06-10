/**
 * UploadHandler - Manages file uploads for LiveTemplate
 *
 * Handles:
 * - File input detection and change events
 * - Chunked uploads to server via WebSocket
 * - External uploads (S3) via presigned URLs
 * - Progress tracking and callbacks
 * - Upload cancellation
 */

import { S3Uploader } from "./s3-uploader";
import type {
  ExternalUploadMeta,
  FileMetadata,
  UploadChunkMessage,
  UploadCompleteMessage,
  UploadEntry,
  UploadHandlerOptions,
  UploadProgressMessage,
  UploadStartMessage,
  UploadStartResponse,
  Uploader,
} from "./types";

export class UploadHandler {
  private entries: Map<string, UploadEntry> = new Map();
  private pendingFiles: Map<string, File[]> = new Map(); // uploadName -> files
  private autoUploadConfig: Map<string, boolean> = new Map(); // uploadName -> autoUpload
  private chunkSize: number;
  private uploaders: Map<string, Uploader> = new Map();
  private onProgress?: (entry: UploadEntry) => void;
  private onComplete?: (uploadName: string, entries: UploadEntry[]) => void;
  private onError?: (entry: UploadEntry, error: string) => void;
  private postMultipartUpload?: (
    formData: FormData,
    signal?: AbortSignal
  ) => Promise<void>;
  private isConnected?: () => boolean;
  private postUploadStart?: (
    message: UploadStartMessage,
    signal?: AbortSignal
  ) => Promise<UploadStartResponse>;
  private pendingHandshakes: Set<AbortController> = new Set();
  private previewUrls: Map<string, string> = new Map(); // uploadName -> object URL
  private inputHandlers: WeakMap<HTMLInputElement, EventListener> = new WeakMap();

  constructor(
    private sendMessage: (message: any) => void,
    options: UploadHandlerOptions = {}
  ) {
    this.chunkSize = options.chunkSize || 256 * 1024; // 256KB default
    this.onProgress = options.onProgress;
    this.onComplete = options.onComplete;
    this.onError = options.onError;
    this.postMultipartUpload = options.postMultipartUpload;
    this.isConnected = options.isConnected;
    this.postUploadStart = options.postUploadStart;

    // Register default uploaders
    this.uploaders.set("s3", new S3Uploader());
  }

  /**
   * Dispatch a valid upload entry to the transport its mode requires. The server
   * declares the mode per-entry; existing entries that only carry `external`
   * (no mode) fall back to the Direct path for backward compatibility.
   */
  private dispatchUpload(entry: UploadEntry): void {
    switch (entry.mode) {
      case "preview":
        this.uploadPreview(entry);
        return;
      case "proxied":
        void this.uploadProxied(entry);
        return;
      case "direct":
        if (entry.external) {
          void this.uploadExternal(entry, entry.external);
        } else {
          // Direct requires presign metadata; surface the misconfig instead of
          // silently abandoning the entry.
          const msg = "direct upload mode requires presigned upload metadata";
          entry.error = msg;
          if (this.onError) this.onError(entry, msg);
          this.cleanupEntries(entry.uploadName);
        }
        return;
      case "volume":
      default:
        // entry.mode is normalized to a concrete mode at ingest (see
        // handleUploadStartResponse), so the default is just the Volume path.
        void this.uploadChunked(entry);
    }
  }

  /**
   * Mark an upload finished and run the shared post-completion steps: fire the
   * onComplete callback, clear the file input, and schedule entry cleanup.
   * Callers that talk to the server (chunked/external) send their own
   * upload_complete message first.
   */
  private finishUpload(entry: UploadEntry): void {
    entry.done = true;
    entry.progress = 100;
    // Emit a final 100% tick so every completed path (proxied included) sends it
    // — a progress bar waiting on 100% won't hang. Idempotent for chunked/external
    // which already reach 100% during transfer.
    if (this.onProgress) {
      this.onProgress(entry);
    }
    if (this.onComplete) {
      this.onComplete(entry.uploadName, [entry]);
    }
    this.clearFileInput(entry.uploadName);
    this.cleanupEntries(entry.uploadName);
  }

  /**
   * Initialize upload detection on file inputs with lvt-upload attribute
   */
  initializeFileInputs(container: Element) {
    const inputs = container.querySelectorAll<HTMLInputElement>(
      'input[type="file"][lvt-upload]'
    );

    inputs.forEach((input) => {
      const uploadName = input.getAttribute("lvt-upload");
      if (!uploadName) return;

      // Remove existing listener if any
      const existingHandler = this.inputHandlers.get(input);
      if (existingHandler) {
        input.removeEventListener("change", existingHandler);
      }

      // Create new handler
      const handler = (e: Event) => {
        const files = (e.target as HTMLInputElement).files;
        if (!files || files.length === 0) return;

        // Always send upload_start to get validation and config
        // But only proceed with chunks if autoUpload is true
        this.startUpload(uploadName, Array.from(files));
      };

      input.addEventListener("change", handler);
      // Store handler in WeakMap to prevent memory leaks
      this.inputHandlers.set(input, handler);
    });
  }

  /**
   * Start upload process for selected files
   */
  async startUpload(uploadName: string, files: File[]): Promise<void> {
    // Store files temporarily for when server response arrives
    this.pendingFiles.set(uploadName, files);

    // Create file metadata
    const fileMetadata: FileMetadata[] = files.map((file) => ({
      name: file.name,
      type: file.type || "application/octet-stream",
      size: file.size,
    }));

    const startMessage: UploadStartMessage = {
      action: "upload_start",
      upload_name: uploadName,
      files: fileMetadata,
    };

    // Over an open WebSocket the server replies with a separate
    // UploadStartResponse message (routed to handleUploadStartResponse). With
    // the socket down, post the handshake over HTTP and handle the response
    // inline so mode dispatch (and Direct presign) still work.
    const connected = this.isConnected ? this.isConnected() : true;
    if (!connected) {
      if (!this.postUploadStart) {
        this.failStart(
          uploadName,
          files,
          "upload unavailable: WebSocket is closed and no HTTP fallback is configured"
        );
        return;
      }
      const controller = new AbortController();
      this.pendingHandshakes.add(controller);
      try {
        const response = await this.postUploadStart(
          startMessage,
          controller.signal
        );
        // Skip if teardown aborted us mid-flight, so we don't create a preview
        // object URL after revokePreviews already ran.
        if (!controller.signal.aborted) {
          await this.handleUploadStartResponse(response);
        }
      } catch (error) {
        this.failStart(
          uploadName,
          files,
          error instanceof Error ? error.message : String(error)
        );
      } finally {
        this.pendingHandshakes.delete(controller);
      }
      return;
    }

    this.sendMessage(startMessage);
  }

  // failStart reports a handshake failure on every selected file and clears the
  // pending set, so a startUpload that can't reach the server isn't silent.
  private failStart(uploadName: string, files: File[], message: string): void {
    this.pendingFiles.delete(uploadName);
    if (!this.onError) return;
    for (const file of files) {
      this.onError(
        { id: "", file, uploadName, progress: 0, bytesUploaded: 0, valid: false, done: false },
        message
      );
    }
  }

  /**
   * Handle upload_start response from server
   */
  async handleUploadStartResponse(
    response: UploadStartResponse
  ): Promise<void> {
    const { upload_name, entries: entryInfos } = response;

    // Store autoUpload configuration from first entry
    if (entryInfos.length > 0) {
      this.autoUploadConfig.set(upload_name, entryInfos[0].auto_upload);
    }

    // Get pending files for this upload
    const files = this.pendingFiles.get(upload_name);
    if (!files) {
      console.error(`No pending files found for upload: ${upload_name}`);
      return;
    }

    // Clear pending files
    this.pendingFiles.delete(upload_name);

    // Build a map from file name to file object for lookup
    const fileMap = new Map<string, File>();
    for (const file of files) {
      fileMap.set(file.name, file);
    }

    // Create upload entries
    const entries: UploadEntry[] = [];

    for (const info of entryInfos) {
      const file = fileMap.get(info.client_name);

      if (!file) {
        console.warn(
          `No file found for entry ${info.entry_id} (client_name: ${info.client_name})`
        );
        continue;
      }

      const entry: UploadEntry = {
        id: info.entry_id,
        file,
        uploadName: upload_name,
        progress: 0,
        bytesUploaded: 0,
        valid: info.valid,
        done: false,
        error: info.error,
        // Normalize legacy responses (no mode) at the ingest boundary: a
        // presigned entry is Direct, otherwise server-side Volume. Downstream
        // dispatch then only ever sees a concrete mode.
        mode: info.mode ?? (info.external ? "direct" : "volume"),
        external: info.external,
      };

      this.entries.set(entry.id, entry);
      entries.push(entry);

      // Handle invalid entries
      if (!info.valid) {
        if (this.onError && info.error) {
          this.onError(entry, info.error);
        }
        continue;
      }

      // Only start upload immediately if autoUpload is true; otherwise the entry
      // waits for an explicit form-submit trigger.
      if (info.auto_upload) {
        this.dispatchUpload(entry);
      }
    }
  }

  /**
   * Upload file using external uploader (S3, etc.)
   */
  private async uploadExternal(
    entry: UploadEntry,
    meta: ExternalUploadMeta
  ): Promise<void> {
    try {
      const uploader = this.uploaders.get(meta.uploader);
      if (!uploader) {
        throw new Error(`Unknown uploader: ${meta.uploader}`);
      }

      // Start external upload with progress callback
      await uploader.upload(entry, meta, this.onProgress);

      // Notify server of completion
      const completeMessage: UploadCompleteMessage = {
        action: "upload_complete",
        upload_name: entry.uploadName,
        entry_ids: [entry.id],
      };

      this.sendMessage(completeMessage);
      this.finishUpload(entry);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      entry.error = errorMsg;
      if (this.onError) {
        this.onError(entry, errorMsg);
      }
      // Schedule cleanup after error
      this.cleanupEntries(entry.uploadName);
    }
  }

  /**
   * Upload a Proxied file as a single multipart POST to the live URL. The server
   * streams the bytes straight to the app's OnUpload handler (zero local-disk
   * staging) and dispatches the upload_<name>_complete action. Independent of
   * the WebSocket, so it works with the socket disabled.
   */
  private async uploadProxied(entry: UploadEntry): Promise<void> {
    if (!this.postMultipartUpload) {
      const msg =
        "Proxied upload unavailable: no multipart transport configured";
      entry.error = msg;
      if (this.onError) this.onError(entry, msg);
      this.cleanupEntries(entry.uploadName);
      return;
    }

    entry.abortController = new AbortController();
    // A single fetch has no native upload progress, so emit a start event (0%)
    // and let finishUpload emit 100% — a progress bar won't sit frozen with no
    // signal at all.
    if (this.onProgress) this.onProgress(entry);
    try {
      const formData = new FormData();
      // Write value fields BEFORE the file part so the server resolves the
      // action regardless of multipart part ordering.
      formData.set("lvt-action", `upload_${entry.uploadName}_complete`);
      formData.set(entry.uploadName, entry.file, entry.file.name);

      await this.postMultipartUpload(formData, entry.abortController.signal);
      this.finishUpload(entry);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      entry.error = errorMsg;
      if (this.onError) {
        this.onError(entry, errorMsg);
      }
      this.cleanupEntries(entry.uploadName);
    }
  }

  /**
   * Preview mode: keep the file on the device and show it locally via an object
   * URL. Nothing is uploaded — the server already has the file's metadata from
   * the upload_start handshake. The blob URL is re-applied after server
   * re-renders by hydratePreviews().
   */
  private uploadPreview(entry: UploadEntry): void {
    // Revoke any prior preview for this field to avoid leaking object URLs.
    const prev = this.previewUrls.get(entry.uploadName);
    if (prev) URL.revokeObjectURL(prev);

    const url = URL.createObjectURL(entry.file);
    this.previewUrls.set(entry.uploadName, url);

    entry.done = true;
    entry.progress = 100;
    this.applyPreview(entry.uploadName, url);

    if (this.onComplete) {
      this.onComplete(entry.uploadName, [entry]);
    }

    // Clear the input and drop the tracking entry, matching every other
    // completed-upload path, so re-submitting doesn't re-trigger on the same
    // file. The blob URL lives in previewUrls (not the input), so the preview
    // survives the clear.
    this.clearFileInput(entry.uploadName);
    this.cleanupEntries(entry.uploadName);
  }

  /** Point every preview placeholder for uploadName at the given object URL. */
  private applyPreview(uploadName: string, url: string): void {
    // Escape the field name so a name with a quote/bracket can't break or inject
    // into the selector. Prefer CSS.escape; without it, only proceed for a simple
    // identifier (the normal case) and otherwise skip rather than run a
    // possibly-broken selector (hydratePreviews still re-applies via attr reads).
    let safeName: string;
    if (typeof CSS !== "undefined" && CSS.escape) {
      safeName = CSS.escape(uploadName);
    } else if (/^[\w-]+$/.test(uploadName)) {
      safeName = uploadName;
    } else {
      return;
    }
    const els = document.querySelectorAll<HTMLElement>(
      `[data-lvt-upload-preview="${safeName}"]`
    );
    els.forEach((el) => {
      if (el instanceof HTMLImageElement) {
        if (el.src !== url) el.src = url;
      } else if (el.getAttribute("src") !== url) {
        el.setAttribute("src", url);
      }
    });
  }

  /**
   * Re-attach Preview-mode blob URLs after a DOM morph. The server re-renders
   * the {{.lvt.UploadPreview}} placeholder with an empty src, so this restores
   * the local object URL the visitor selected. Called by the client post-update.
   */
  hydratePreviews(root: Element): void {
    const apply = (el: Element) => {
      const name = el.getAttribute("data-lvt-upload-preview");
      if (!name) return;
      const url = this.previewUrls.get(name);
      if (!url) return;
      if (el instanceof HTMLImageElement) {
        if (el.src !== url) el.src = url;
      } else if (el.getAttribute("src") !== url) {
        el.setAttribute("src", url);
      }
    };
    // querySelectorAll skips the root itself, so match it explicitly.
    if (root.matches("[data-lvt-upload-preview]")) apply(root);
    root
      .querySelectorAll<HTMLElement>("[data-lvt-upload-preview]")
      .forEach(apply);
  }

  /** Revoke all preview object URLs. Called on teardown to avoid leaks. */
  revokePreviews(): void {
    // Abort in-flight offline handshakes first so a late resolution doesn't
    // create a new preview URL after we've cleared the map.
    for (const controller of this.pendingHandshakes) {
      controller.abort();
    }
    this.pendingHandshakes.clear();
    for (const url of this.previewUrls.values()) {
      URL.revokeObjectURL(url);
    }
    this.previewUrls.clear();
  }

  /**
   * Upload file in chunks via WebSocket
   */
  private async uploadChunked(entry: UploadEntry): Promise<void> {
    const { file, id } = entry;
    let offset = 0;

    // Create abort controller for cancellation
    entry.abortController = new AbortController();

    try {
      while (offset < file.size) {
        // Check if upload was cancelled
        if (entry.abortController.signal.aborted) {
          throw new Error("Upload cancelled");
        }
        // Read chunk
        const end = Math.min(offset + this.chunkSize, file.size);
        const chunk = file.slice(offset, end);

        // Convert to base64
        const base64 = await this.fileToBase64(chunk);

        // Send chunk
        const chunkMessage: UploadChunkMessage = {
          action: "upload_chunk",
          entry_id: id,
          chunk_base64: base64,
          offset,
          total: file.size,
        };

        this.sendMessage(chunkMessage);

        // Update progress
        offset = end;
        entry.bytesUploaded = offset;
        entry.progress = Math.round((offset / file.size) * 100);

        if (this.onProgress) {
          this.onProgress(entry);
        }
      }

      // Send complete message
      entry.done = true;
      const completeMessage: UploadCompleteMessage = {
        action: "upload_complete",
        upload_name: entry.uploadName,
        entry_ids: [id],
      };

      this.sendMessage(completeMessage);
      this.finishUpload(entry);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      entry.error = errorMsg;
      if (this.onError) {
        this.onError(entry, errorMsg);
      }
      // Schedule cleanup after error
      this.cleanupEntries(entry.uploadName);
    }
  }

  /**
   * Handle progress message from server (for chunked uploads)
   */
  handleProgressMessage(message: UploadProgressMessage): void {
    const entry = this.entries.get(message.entry_id);
    if (!entry) return;

    entry.progress = message.progress;
    entry.bytesUploaded = message.bytes_recv;

    if (this.onProgress) {
      this.onProgress(entry);
    }
  }

  /**
   * Cancel upload
   */
  cancelUpload(entryId: string): void {
    const entry = this.entries.get(entryId);
    if (!entry) return;

    // Abort external upload if in progress
    if (entry.abortController) {
      entry.abortController.abort();
    }

    // Send cancel message to server
    this.sendMessage({
      action: "cancel_upload",
      entry_id: entryId,
    });

    // Remove entry
    this.entries.delete(entryId);
  }

  /**
   * Get all entries for an upload name
   */
  getEntries(uploadName: string): UploadEntry[] {
    const entries: UploadEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.uploadName === uploadName) {
        entries.push(entry);
      }
    }
    return entries;
  }

  /**
   * Trigger upload for all pending entries (used when autoUpload is false)
   * Called by LiveTemplate client on form submit
   */
  triggerPendingUploads(uploadName: string): void {
    // Get all entries for this upload that haven't started yet
    const pendingEntries: UploadEntry[] = [];
    for (const entry of this.entries.values()) {
      if (
        entry.uploadName === uploadName &&
        entry.progress === 0 &&
        !entry.done &&
        !entry.error
      ) {
        pendingEntries.push(entry);
      }
    }

    // Start uploads
    for (const entry of pendingEntries) {
      this.dispatchUpload(entry);
    }
  }

  /**
   * Register custom uploader
   */
  registerUploader(name: string, uploader: Uploader): void {
    this.uploaders.set(name, uploader);
  }

  /**
   * Clear file input to prevent re-upload of the same file
   * Called after successful upload completion
   */
  private clearFileInput(uploadName: string): void {
    // Find all file inputs with this upload name
    const inputs = document.querySelectorAll<HTMLInputElement>(
      `input[type="file"][lvt-upload="${uploadName}"]`
    );

    inputs.forEach((input) => {
      // Clear the file input value
      input.value = '';
    });
  }

  /**
   * Clean up completed or errored upload entries to prevent memory leaks
   * Automatically called after completion/error, but can be called manually
   * @param uploadName - Optional upload name to clean specific uploads
   * @param delay - Optional delay in ms before cleanup (default: 5000ms)
   */
  cleanupEntries(uploadName?: string, delay: number = 5000): void {
    setTimeout(() => {
      const entriesToRemove: string[] = [];

      for (const [id, entry] of this.entries) {
        // Skip if uploadName is specified and doesn't match
        if (uploadName && entry.uploadName !== uploadName) continue;

        // Remove completed or errored entries
        if (entry.done || entry.error) {
          entriesToRemove.push(id);
        }
      }

      for (const id of entriesToRemove) {
        this.entries.delete(id);
      }
    }, delay);
  }

  /**
   * Convert File/Blob to base64 string
   */
  private fileToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Remove data URL prefix
        const base64 = result.split(",")[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
}
