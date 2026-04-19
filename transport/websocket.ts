import type { LiveTemplateClientOptions, UpdateResponse } from "../types";
import type { Logger } from "../utils/logger";

export interface WebSocketTransportOptions {
  url: string;
  autoReconnect?: boolean;
  reconnectDelay?: number;
  maxReconnectDelay?: number; // Maximum delay between reconnect attempts (default: 16000ms)
  maxReconnectAttempts?: number; // Maximum number of reconnect attempts (default: 10, 0 = unlimited)
  onOpen?: (socket: WebSocket) => void;
  onMessage?: (event: MessageEvent<string>) => void;
  onClose?: (event: CloseEvent) => void;
  onReconnectAttempt?: (attempt: number, delay: number) => void;
  onReconnectFailed?: () => void; // Called when max reconnect attempts reached
  onError?: (event: Event) => void;
}

/**
 * Lightweight wrapper around browser WebSocket with optional auto-reconnect support.
 * Implements exponential backoff with jitter to prevent thundering herd.
 */
export class WebSocketTransport {
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private manuallyClosed = false;
  private reconnectAttempts = 0;

  constructor(private readonly options: WebSocketTransportOptions) {}

  connect(): void {
    this.manuallyClosed = false;
    this.clearReconnectTimer();

    this.socket = new WebSocket(this.options.url);
    const socket = this.socket;

    socket.onopen = () => {
      // Reset reconnect attempts on successful connection
      this.reconnectAttempts = 0;
      this.options.onOpen?.(socket);
    };

    socket.onmessage = (event: MessageEvent<string>) => {
      this.options.onMessage?.(event);
    };

    socket.onclose = (event: CloseEvent) => {
      this.options.onClose?.(event);
      if (!this.manuallyClosed && this.options.autoReconnect) {
        this.scheduleReconnect();
      }
    };

    socket.onerror = (event: Event) => {
      this.options.onError?.(event);
    };
  }

  send(data: string): void {
    if (this.socket && this.socket.readyState === 1) {  // WebSocket.OPEN = 1
      this.socket.send(data);
    }
  }

  disconnect(): void {
    this.manuallyClosed = true;
    this.clearReconnectTimer();
    if (this.socket) {
      this.options.onClose?.(
        new CloseEvent("close", { code: 1000, reason: "", wasClean: true }),
      );
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.close();
      this.socket = null;
    }
  }

  getSocket(): WebSocket | null {
    return this.socket;
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();

    // Check if max reconnect attempts reached
    const maxAttempts = this.options.maxReconnectAttempts ?? 10;
    if (maxAttempts > 0 && this.reconnectAttempts >= maxAttempts) {
      this.options.onReconnectFailed?.();
      return;
    }

    this.reconnectAttempts++;

    // Calculate exponential backoff: baseDelay * 2^attempt
    const baseDelay = this.options.reconnectDelay ?? 1000;
    const maxDelay = this.options.maxReconnectDelay ?? 16000;
    const exponentialDelay = baseDelay * Math.pow(2, this.reconnectAttempts - 1);

    // Add jitter: random value between 0 and 1000ms to prevent thundering herd
    const jitter = Math.random() * 1000;

    // Calculate final delay with maximum cap
    const delay = Math.min(exponentialDelay + jitter, maxDelay);

    this.reconnectTimer = window.setTimeout(() => {
      this.options.onReconnectAttempt?.(this.reconnectAttempts, delay);
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

export interface WebSocketManagerConfig {
  options: LiveTemplateClientOptions;
  onConnected: () => void;
  onDisconnected: () => void;
  onMessage: (response: UpdateResponse, event: MessageEvent<string>) => void;
  onReconnectAttempt?: (attempt: number, delay: number) => void;
  onReconnectFailed?: () => void;
  onError?: (event: Event) => void;
  logger: Logger;
}

export interface WebSocketConnectResult {
  usingWebSocket: boolean;
  initialState?: UpdateResponse | null;
}

export class WebSocketManager {
  private transport: WebSocketTransport | null = null;
  // Optional override for liveUrl, set by the client on cross-handler
  // navigation. When set, takes precedence over options.liveUrl. This
  // avoids mutating the caller-provided options object.
  private liveUrlOverride: string | null = null;

  constructor(private readonly config: WebSocketManagerConfig) {}

  /**
   * Update the live URL used for WebSocket reconnection. Called by the
   * client on cross-handler navigation so the next connect() uses the
   * new page path without mutating the shared options object.
   */
  setLiveUrl(liveUrl: string): void {
    this.liveUrlOverride = liveUrl;
  }

  async connect(): Promise<WebSocketConnectResult> {
    const liveUrl = this.getLiveUrl();

    const wsAvailable = await checkWebSocketAvailability(
      liveUrl,
      this.config.logger
    );
    if (!wsAvailable) {
      const initialState = await fetchInitialState(liveUrl, this.config.logger);
      return { usingWebSocket: false, initialState };
    }

    // Await onopen before resolving, so downstream setup runs with a ready
    // transport. Without this, observer callbacks during CONNECTING fall
    // back to HTTP, which hits a separate server state path than the WS
    // event loop — producing stale/desynced responses.
    //
    // Three settle paths: onOpen (success), onClose/onError (immediate
    // failure), and a 10s timeout (silent network drop — TCP may never
    // surface a close/error event through a misbehaving middlebox).
    let resolveOpen!: (value: WebSocketConnectResult) => void;
    let rejectOpen!: (reason?: unknown) => void;
    const openPromise = new Promise<WebSocketConnectResult>((resolve, reject) => {
      resolveOpen = resolve;
      rejectOpen = reject;
    });
    let settled = false;
    // Tracks whether onOpen ever fired. Gates onDisconnected so we don't
    // fire a spurious "disconnected" notification on the HTTP fallback
    // path where the socket closed before it ever opened (either
    // naturally via onClose/onError, or because the catch block
    // explicitly disconnects the transport after the 10s timeout).
    let hasConnected = false;
    // Declared before settleOpen to avoid a temporal dead zone on the
    // closure reference — settleOpen is called from onOpen/onClose/onError
    // (all async, so safe today), but declaring the binding up front lets
    // any future synchronous call path still work without a ReferenceError.
    let openTimeoutId: ReturnType<typeof setTimeout> | null = null;
    const settleOpen = (err?: Error): void => {
      if (settled) return;
      settled = true;
      if (openTimeoutId !== null) {
        clearTimeout(openTimeoutId);
        openTimeoutId = null;
      }
      if (err) rejectOpen(err);
      else resolveOpen({ usingWebSocket: true });
    };
    openTimeoutId = setTimeout(() => {
      settleOpen(new Error("WebSocket open timed out after 10s"));
    }, 10000);

    this.transport = new WebSocketTransport({
      url: this.getWebSocketUrl(),
      autoReconnect: this.config.options.autoReconnect,
      reconnectDelay: this.config.options.reconnectDelay,
      maxReconnectDelay: 16000, // 16 seconds maximum
      maxReconnectAttempts: 10, // 10 attempts before giving up
      onOpen: () => {
        hasConnected = true;
        this.config.onConnected();
        settleOpen();
      },
      onMessage: (event) => {
        try {
          const payload: UpdateResponse = JSON.parse(event.data);
          this.config.onMessage(payload, event);
        } catch (error) {
          this.config.logger.error("Failed to parse WebSocket message:", error);
        }
      },
      onClose: () => {
        // Branch on whether we'd actually connected:
        //   - Success path (onOpen fired): notify client of disconnection
        //     via onDisconnected(). Do NOT call settleOpen — it's already
        //     resolved, and we'd needlessly construct an Error object
        //     that shows up in any log/trace capturing rejection reasons.
        //   - Failure path (close before open): reject the openPromise
        //     with a descriptive Error. onDisconnected is NOT fired
        //     because we were never "connected" from the client's POV.
        if (hasConnected) {
          this.config.onDisconnected();
        } else {
          settleOpen(new Error("WebSocket closed before it opened"));
        }
      },
      onReconnectAttempt: (attempt, delay) => {
        this.config.onReconnectAttempt?.(attempt, delay);
      },
      onReconnectFailed: () => {
        this.config.onReconnectFailed?.();
      },
      onError: (event) => {
        this.config.onError?.(event);
        // If we're already connected, onDisconnected is fired via the
        // subsequent onClose — per WHATWG WebSocket spec, onclose always
        // fires after onerror when the connection is lost post-open.
        // We rely on that invariant here rather than double-firing
        // onDisconnected (which would require tracking a separate
        // "already disconnected" flag).
        //
        // If we're NOT yet connected, this rejects openPromise so the
        // catch block falls back to HTTP. settleOpen is a no-op post-open.
        settleOpen(new Error("WebSocket errored before it opened"));
      },
    });

    this.transport.connect();

    try {
      return await openPromise;
    } catch (err) {
      this.config.logger.warn("WebSocket open failed, falling back to HTTP", err);
      // Stop the transport so a late onOpen or auto-reconnect doesn't fire
      // against a client that has already committed to HTTP mode.
      this.transport?.disconnect();
      this.transport = null;
      const initialState = await fetchInitialState(liveUrl, this.config.logger);
      return { usingWebSocket: false, initialState };
    }
  }

  disconnect(): void {
    this.transport?.disconnect();
    this.transport = null;
  }

  send(data: string): void {
    this.transport?.send(data);
  }

  getReadyState(): number | undefined {
    return this.transport?.getSocket()?.readyState;
  }

  getSocket(): WebSocket | null {
    return this.transport?.getSocket() ?? null;
  }

  private getWebSocketUrl(): string {
    const liveUrl = this.liveUrlOverride || this.config.options.liveUrl || "/live";
    const baseUrl = this.config.options.wsUrl;
    if (baseUrl) {
      return baseUrl;
    }
    const wsScheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${wsScheme}//${window.location.host}${liveUrl}`;
  }

  private getLiveUrl(): string {
    return (
      this.liveUrlOverride ||
      this.config.options.liveUrl ||
      window.location.pathname + window.location.search
    );
  }
}

export async function checkWebSocketAvailability(
  liveUrl: string,
  logger?: Logger
): Promise<boolean> {
  try {
    const response = await fetch(liveUrl, {
      method: "HEAD",
    });

    const wsHeader = response.headers.get("X-LiveTemplate-WebSocket");
    if (wsHeader) {
      return wsHeader === "enabled";
    }

    return true;
  } catch (error) {
    logger?.warn("Failed to check WebSocket availability:", error);
    return true;
  }
}

export async function fetchInitialState(
  liveUrl: string,
  logger?: Logger
): Promise<UpdateResponse | null> {
  try {
    const response = await fetch(liveUrl, {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch initial state: ${response.status}`);
    }

    return (await response.json()) as UpdateResponse;
  } catch (error) {
    logger?.warn("Failed to fetch initial state:", error);
    return null;
  }
}
