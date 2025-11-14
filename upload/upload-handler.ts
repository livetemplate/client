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
  private chunkSize: number;
  private uploaders: Map<string, Uploader> = new Map();
  private onProgress?: (entry: UploadEntry) => void;
  private onComplete?: (uploadName: string, entries: UploadEntry[]) => void;
  private onError?: (entry: UploadEntry, error: string) => void;
  private inputHandlers: WeakMap<HTMLInputElement, EventListener> = new WeakMap();

  constructor(
    private sendMessage: (message: any) => void,
    options: UploadHandlerOptions = {}
  ) {
    this.chunkSize = options.chunkSize || 256 * 1024; // 256KB default
    this.onProgress = options.onProgress;
    this.onComplete = options.onComplete;
    this.onError = options.onError;

    // Register default uploaders
    this.uploaders.set("s3", new S3Uploader());
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

    // Send upload_start message to server
    const startMessage: UploadStartMessage = {
      action: "upload_start",
      upload_name: uploadName,
      files: fileMetadata,
    };

    this.sendMessage(startMessage);
  }

  /**
   * Handle upload_start response from server
   */
  async handleUploadStartResponse(
    response: UploadStartResponse
  ): Promise<void> {
    const { upload_name, entries: entryInfos } = response;

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

      // Start upload (external or chunked)
      if (info.external) {
        this.uploadExternal(entry, info.external);
      } else {
        this.uploadChunked(entry);
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

      if (this.onComplete) {
        this.onComplete(entry.uploadName, [entry]);
      }

      // Schedule cleanup after completion
      this.cleanupEntries(entry.uploadName);
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

      if (this.onComplete) {
        this.onComplete(entry.uploadName, [entry]);
      }

      // Schedule cleanup after completion
      this.cleanupEntries(entry.uploadName);
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
   * Register custom uploader
   */
  registerUploader(name: string, uploader: Uploader): void {
    this.uploaders.set(name, uploader);
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
