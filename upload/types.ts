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

/**
 * UploadMode mirrors the server's UploadConfig.Mode. It is chosen purely by
 * server config and delivered per-entry in the upload_start response; the client
 * dispatches the matching transport.
 *  - "volume":  WebSocket-chunked staging to the server's disk
 *  - "direct":  browser → cloud via a presigned URL (carries `external`)
 *  - "proxied": one multipart POST per file → server streams to remote storage
 *  - "preview": file stays on device; only metadata is sent
 */
export type UploadMode = "volume" | "direct" | "proxied" | "preview";

export interface UploadEntryInfo {
  entry_id: string;
  client_name: string;
  valid: boolean;
  error?: string;
  auto_upload: boolean;
  mode?: UploadMode;
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
  mode?: UploadMode;
  external?: ExternalUploadMeta;
  abortController?: AbortController;
  // The file input that triggered this upload, when known. Proxied uploads use
  // its enclosing form to serialize the form's value fields (e.g. a record id)
  // into the multipart POST, so the server can associate the streamed bytes with
  // a record inside OnUpload.
  sourceInput?: HTMLInputElement;
}

export type UploadProgressCallback = (entry: UploadEntry) => void;
export type UploadCompleteCallback = (uploadName: string, entries: UploadEntry[]) => void;
export type UploadErrorCallback = (entry: UploadEntry, error: string) => void;

export interface UploadHandlerOptions {
  chunkSize?: number;
  onProgress?: UploadProgressCallback;
  onComplete?: UploadCompleteCallback;
  onError?: UploadErrorCallback;
  /**
   * Posts a Proxied upload's multipart body (file + action fields) to the live
   * URL and applies the server's tree response. Injected by the LiveTemplate
   * client so the upload handler stays transport-agnostic. Resolves when the
   * POST completes; rejects on a non-2xx response.
   */
  postMultipartUpload?: (formData: FormData, signal?: AbortSignal) => Promise<void>;
  /**
   * Reports whether the WebSocket is currently usable. When false, the upload
   * handshake is sent over HTTP instead (see postUploadStart).
   */
  isConnected?: () => boolean;
  /**
   * Posts an upload_start handshake over HTTP and returns the parsed response.
   * Used when the WebSocket is down so mode dispatch (and Direct presign) still
   * work. Injected by the LiveTemplate client; rejects on a non-2xx response.
   */
  postUploadStart?: (
    message: UploadStartMessage,
    signal?: AbortSignal
  ) => Promise<UploadStartResponse>;
}

export interface Uploader {
  upload(
    entry: UploadEntry,
    meta: ExternalUploadMeta,
    onProgress?: UploadProgressCallback
  ): Promise<void>;
}
