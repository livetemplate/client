/**
 * S3Uploader - Handles direct uploads to S3 using presigned URLs
 */

import type {
  ExternalUploadMeta,
  UploadEntry,
  UploadProgressCallback,
  Uploader,
} from "./types";

export class S3Uploader implements Uploader {
  /**
   * Upload a file directly to S3 using presigned PUT URL
   */
  async upload(
    entry: UploadEntry,
    meta: ExternalUploadMeta,
    onProgress?: UploadProgressCallback
  ): Promise<void> {
    const { file } = entry;

    // Create abort controller for cancellation
    entry.abortController = new AbortController();

    try {
      // Create XMLHttpRequest for progress tracking
      const xhr = new XMLHttpRequest();

      // Track upload progress and notify handler
      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) {
          entry.bytesUploaded = e.loaded;
          entry.progress = Math.round((e.loaded / e.total) * 100);
          // Notify progress callback
          if (onProgress) {
            onProgress(entry);
          }
        }
      });

      // Handle abort
      entry.abortController.signal.addEventListener("abort", () => {
        xhr.abort();
      });

      // Create promise for upload completion
      const uploadPromise = new Promise<void>((resolve, reject) => {
        xhr.addEventListener("load", () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            entry.done = true;
            entry.progress = 100;
            resolve();
          } else {
            reject(new Error(`S3 upload failed with status ${xhr.status}: ${xhr.statusText}`));
          }
        });

        xhr.addEventListener("error", () => {
          reject(new Error("S3 upload failed: Network error"));
        });

        xhr.addEventListener("abort", () => {
          reject(new Error("S3 upload cancelled"));
        });
      });

      // Open connection
      xhr.open("PUT", meta.url);

      // Set headers
      if (meta.headers) {
        for (const [key, value] of Object.entries(meta.headers)) {
          xhr.setRequestHeader(key, value);
        }
      }

      // Send file
      xhr.send(file);

      await uploadPromise;
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
}
