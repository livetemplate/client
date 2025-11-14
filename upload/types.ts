/**
 * Upload types and interfaces for LiveTemplate client
 */

export interface FileMetadata {
  name: string;
  type: string;
  size: number;
}

export interface UploadConfig {
  accept?: string[];
  maxEntries?: number;
  maxFileSize?: number;
  autoUpload?: boolean;
  chunkSize?: number;
}

export interface UploadEntryInfo {
  entry_id: string;
  client_name: string;
  valid: boolean;
  error?: string;
  auto_upload: boolean;
  external?: ExternalUploadMeta;
}

export interface ExternalUploadMeta {
  uploader: string;
  url: string;
  fields?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface UploadStartMessage {
  action: "upload_start";
  upload_name: string;
  files: FileMetadata[];
}

export interface UploadStartResponse {
  upload_name: string;
  entries: UploadEntryInfo[];
}

export interface UploadChunkMessage {
  action: "upload_chunk";
  entry_id: string;
  chunk_base64: string;
  offset: number;
  total: number;
}

export interface UploadProgressMessage {
  type: "upload_progress";
  upload_name: string;
  entry_id: string;
  client_name: string;
  progress: number;
  bytes_recv: number;
  bytes_total: number;
}

export interface UploadCompleteMessage {
  action: "upload_complete";
  upload_name: string;
  entry_ids: string[];
}

export interface UploadCompleteResponse {
  upload_name: string;
  success: boolean;
  error?: string;
}

export interface CancelUploadMessage {
  action: "cancel_upload";
  entry_id: string;
}

export interface CancelUploadResponse {
  entry_id: string;
  success: boolean;
}

export interface UploadEntry {
  id: string;
  file: File;
  uploadName: string;
  progress: number;
  bytesUploaded: number;
  valid: boolean;
  done: boolean;
  error?: string;
  external?: ExternalUploadMeta;
  abortController?: AbortController;
}

export type UploadProgressCallback = (entry: UploadEntry) => void;
export type UploadCompleteCallback = (uploadName: string, entries: UploadEntry[]) => void;
export type UploadErrorCallback = (entry: UploadEntry, error: string) => void;

export interface UploadHandlerOptions {
  chunkSize?: number;
  onProgress?: UploadProgressCallback;
  onComplete?: UploadCompleteCallback;
  onError?: UploadErrorCallback;
}

export interface Uploader {
  upload(
    entry: UploadEntry,
    meta: ExternalUploadMeta,
    onProgress?: UploadProgressCallback
  ): Promise<void>;
}
