/**
 * LiveTemplate TypeScript Client
 *
 * Reconstructs HTML from tree-based updates using cached static structure,
 * following the Phoenix LiveView optimization approach.
 */

import morphdom from "morphdom";
import { FocusManager } from "./dom/focus-manager";
import {
  handleAnimateDirectives,
  handleHighlightDirectives,
  handleScrollDirectives,
  handleToastDirectives,
  setupToastClickOutside,
  setupFxDOMEventTriggers,
  teardownFxDOMEventTriggers,
  setupFxLifecycleListeners,
  teardownFxLifecycleListeners,
} from "./dom/directives";
import { EventDelegator } from "./dom/event-delegation";
import { LinkInterceptor } from "./dom/link-interceptor";
import { ObserverManager } from "./dom/observer-manager";
import { LoadingIndicator } from "./dom/loading-indicator";
import { FormDisabler } from "./dom/form-disabler";
import { setupReactiveAttributeListeners } from "./dom/reactive-attributes";
import { setupInvokerPolyfill } from "./dom/invoker-polyfill";
import { setupHashLink, teardownHashLink, openFromHash, safeMatchesPopoverOpen } from "./dom/hash-link";
import { setupScrollAway, teardownScrollAway } from "./dom/scroll-away";
import { TreeRenderer } from "./state/tree-renderer";
import {
  RangeDomApplier,
  TARGETED_APPLIED_ATTR,
  TARGETED_SKIP_ATTR,
} from "./state/range-dom-applier";
import { FormLifecycleManager } from "./state/form-lifecycle-manager";
import { ChangeAutoWirer } from "./state/change-auto-wirer";
import { WebSocketManager } from "./transport/websocket";
import { UploadHandler } from "./upload/upload-handler";
import type {
  UploadProgressMessage,
  UploadStartResponse,
} from "./upload/types";
import type {
  LiveTemplateClientOptions,
  ResponseMetadata,
  TreeNode,
  UpdateResponse,
  UpdateResult,
} from "./types";
import { createLogger, Logger } from "./utils/logger";
export { loadAndApplyUpdate, compareHTML } from "./utils/testing";
export { setupReactiveAttributeListeners } from "./dom/reactive-attributes";

export class LiveTemplateClient {
  private readonly treeRenderer: TreeRenderer;
  private readonly rangeDomApplier: RangeDomApplier;
  private nodesAddedThisRender: number = 0;
  private directiveTouchedThisRender: boolean = false;
  private readonly focusManager: FocusManager;
  private readonly logger: Logger;
  private lvtId: string | null = null;

  // Transport properties
  private webSocketManager: WebSocketManager;
  public ws: WebSocket | null = null;
  private wrapperElement: Element | null = null;
  private options: LiveTemplateClientOptions;
  private useHTTP: boolean = false; // True when WebSocket is unavailable
  private sessionCookie: string | null = null; // For HTTP mode session tracking

  // Rate limiting: cache of debounced/throttled handlers per element+eventType
  private rateLimitedHandlers: WeakMap<Element, Map<string, Function>> =
    new WeakMap();

  private eventDelegator: EventDelegator;
  private linkInterceptor: LinkInterceptor;
  private observerManager: ObserverManager;
  private formLifecycleManager: FormLifecycleManager;
  private loadingIndicator: LoadingIndicator;
  private formDisabler: FormDisabler;
  private uploadHandler: UploadHandler;
  private changeAutoWirer: ChangeAutoWirer;

  // Initialization tracking for loading indicator
  private isInitialized: boolean = false;

  // Message tracking for deterministic E2E testing
  private messageCount: number = 0;

  // Cross-handler navigation: track the latest in-flight connect() so a
  // subsequent navigation can supersede an earlier one. Incremented on
  // each cross-handler navigation; handlers check the epoch to avoid
  // applying stale connection results.
  private navigationEpoch: number = 0;

  // Override for the live URL used by HTTP send and multipart methods.
  // Updated on cross-handler navigation so HTTP requests go to the new
  // handler path. When null, falls back to options.liveUrl. We avoid
  // mutating the options object so callers holding a reference don't
  // observe side-effects.
  private liveUrlOverride: string | null = null;

  // Visibility-based reconnection: when the browser tab returns from
  // background (iOS app switch, Android task switch), the WebSocket is
  // often silently dead. These fields drive a one-shot reconnect on
  // the visibilitychange event, independent of autoReconnect (which
  // guards against retry loops on persistent network failures).
  // Handlers are stored as instance properties so disconnect() can
  // remove them — without that, SPAs that build a new client per route
  // accumulate listeners that hold closures over destroyed instances.
  private visibilityHandlerAttached: boolean = false;
  private hiddenAt: number = 0;
  private reconnecting: boolean = false;
  private visibilityHandler: (() => void) | null = null;
  private pageshowHandler: ((e: PageTransitionEvent) => void) | null = null;
  private visibilityReconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: LiveTemplateClientOptions = {}) {
    const { logger: providedLogger, logLevel, debug, ...restOptions } = options;
    const resolvedLevel = logLevel ?? (debug ? "debug" : "info");
    const baseLogger = providedLogger ?? createLogger({ level: resolvedLevel });

    if (providedLogger) {
      if (logLevel) {
        providedLogger.setLevel(logLevel);
      } else if (debug) {
        providedLogger.setLevel("debug");
      }
    } else {
      baseLogger.setLevel(resolvedLevel);
    }

    this.logger = baseLogger.child("Client");

    this.options = {
      autoReconnect: false, // Disable autoReconnect by default to avoid connection loops
      reconnectDelay: 1000,
      // liveUrl captures the current page URL (path + search) so the
      // initial WebSocket handshake reaches the server with the same
      // query params Mount saw on the HTTP GET. This is intentional —
      // without the search, the WS-side Mount re-runs with empty data
      // and drifts state from the HTTP render.
      //
      // For *same-handler* SPA navigation (changing query params on
      // the same path), the client does NOT reconnect — instead it
      // sends an in-band {action:"__navigate__", data:<params>} message
      // over the existing WebSocket, and the server re-runs Mount with
      // the new data. See sendNavigate() and handleNavigationResponse()
      // for the SPA path. Cross-handler SPA navigation still does the
      // fetch-and-replaceChildren+reconnect dance.
      liveUrl: window.location.pathname + window.location.search,
      ...restOptions,
    };

    this.treeRenderer = new TreeRenderer(this.logger.child("TreeRenderer"));
    this.rangeDomApplier = new RangeDomApplier({
      logger: this.logger.child("RangeDomApplier"),
      renderItem: (item, idx, statics, sm, sp) =>
        this.treeRenderer.renderRangeItem(item, idx, statics, sm, sp),
      executeLifecycleHook: (el, hook) => this.executeLifecycleHook(el, hook),
      itemLookup: (rangePath, key) => {
        // O(N) linear scan over range.d. For one `u` op per render this is
        // ~50µs at N=10k — acceptable. For a render with many u ops on
        // the same range, this becomes O(N×K); building a Map<key, item>
        // once at apply() start would amortize, but the gain is small
        // (whole `u` op cost is dominated by morphdom on the row anyway).
        // Revisit if profiling shows this on the hot path.
        const range = this.treeRenderer.getTreeState()[rangePath];
        if (!range || !Array.isArray(range.d)) return null;
        const idKey = range.m?.idKey;
        for (const item of range.d) {
          if (!item || typeof item !== "object") continue;
          if (item._k === key) return item;
          if (
            idKey &&
            item[idKey] !== undefined &&
            String(item[idKey]) === key
          ) {
            return item;
          }
        }
        return null;
      },
      onNodeAdded: () => {
        this.nodesAddedThisRender++;
      },
    });
    this.focusManager = new FocusManager(this.logger.child("FocusManager"));

    this.formLifecycleManager = new FormLifecycleManager();
    this.loadingIndicator = new LoadingIndicator();
    this.formDisabler = new FormDisabler();

    // Initialize upload handler
    this.uploadHandler = new UploadHandler(
      (message) => this.send(message),
      {
        chunkSize: 256 * 1024, // 256KB chunks
        onProgress: (entry) => {
          // Trigger DOM update to refresh upload progress
          if (this.wrapperElement) {
            this.wrapperElement.dispatchEvent(
              new CustomEvent("lvt:upload:progress", {
                detail: { entry },
              })
            );
          }
        },
        onComplete: (uploadName, entries) => {
          this.logger.info(`Upload complete: ${uploadName}`, entries);
          if (this.wrapperElement) {
            this.wrapperElement.dispatchEvent(
              new CustomEvent("lvt:upload:complete", {
                detail: { uploadName, entries },
              })
            );
          }
        },
        onError: (entry, error) => {
          this.logger.error(`Upload error for ${entry.id}:`, error);
          if (this.wrapperElement) {
            this.wrapperElement.dispatchEvent(
              new CustomEvent("lvt:upload:error", {
                detail: { entry, error },
              })
            );
          }
        },
      }
    );

    this.eventDelegator = new EventDelegator(
      {
        getWrapperElement: () => this.wrapperElement,
        getRateLimitedHandlers: () => this.rateLimitedHandlers,
        parseValue: (value: string) => this.parseValue(value),
        send: (message: any) => this.send(message),
        sendHTTPMultipart: (form: HTMLFormElement, action: string, formData: FormData) =>
          this.sendHTTPMultipart(form, action, formData),
        setActiveSubmission: (
          form: HTMLFormElement | null,
          button: HTMLButtonElement | null,
          originalButtonText: string | null
        ) =>
          this.formLifecycleManager.setActiveSubmission(
            form,
            button,
            originalButtonText
          ),
        getWebSocketReadyState: () => this.webSocketManager.getReadyState(),
        triggerPendingUploads: (uploadName: string) =>
          this.uploadHandler.triggerPendingUploads(uploadName),
      },
      this.logger.child("EventDelegator")
    );

    this.linkInterceptor = new LinkInterceptor(
      {
        getWrapperElement: () => this.wrapperElement,
        handleNavigationResponse: (html: string) => this.handleNavigationResponse(html),
        sendNavigate: (href: string) => this.sendNavigate(href),
        // Only take the in-band fast path when the WS is actually OPEN.
        // If WS is CONNECTING or CLOSED, falling through to the normal fetch
        // path is safer: pushState fires after the fetch resolves (not before),
        // so the browser URL never gets ahead of server state.
        canSendNavigate: () =>
          !this.useHTTP &&
          this.webSocketManager.getReadyState() === 1 /* WebSocket.OPEN */,
      },
      this.logger.child("LinkInterceptor")
    );

    this.observerManager = new ObserverManager(
      {
        getWrapperElement: () => this.wrapperElement,
        send: (message: any) => this.send(message),
      },
      this.logger.child("ObserverManager")
    );

    this.changeAutoWirer = new ChangeAutoWirer(
      {
        getWrapperElement: () => this.wrapperElement,
        send: (message) => this.send(message),
      },
      this.logger.child("ChangeAutoWirer")
    );

    this.webSocketManager = new WebSocketManager({
      options: this.options,
      logger: this.logger.child("Transport"),
      onConnected: () => {
        this.ws = this.webSocketManager.getSocket();
        this.logger.info("WebSocket connected");

        // Clear flash-related query params from URL to prevent stale flash on reload
        // This handles the redirect pattern: /auth?error=invalid_credentials
        this.clearFlashQueryParams();

        this.options.onConnect?.();
        this.wrapperElement?.dispatchEvent(new Event("lvt:connected"));
      },
      onDisconnected: () => {
        this.ws = null;
        this.logger.info("WebSocket disconnected");
        this.options.onDisconnect?.();
        this.wrapperElement?.dispatchEvent(new Event("lvt:disconnected"));
      },
      onMessage: (response, event) => {
        this.handleWebSocketPayload(response, event);
      },
      onReconnectAttempt: () => {
        this.logger.info("Attempting to reconnect...");
      },
      onError: (error) => {
        this.logger.error("WebSocket error:", error);
        this.options.onError?.(error);
      },
    });
  }

  /**
   * Auto-initialize when DOM is ready
   * Called automatically when script loads
   */
  static autoInit(): void {
    const autoInitLogger = createLogger({ scope: "Client:autoInit" });
    const init = () => {
      const wrapper = document.querySelector("[data-lvt-id]");
      if (wrapper) {
        const client = new LiveTemplateClient();
        client.wrapperElement = wrapper;

        // Check if loading indicator should be shown
        const shouldShowLoading =
          wrapper.getAttribute("data-lvt-loading") === "true";
        if (shouldShowLoading) {
          client.loadingIndicator.show();
          client.formDisabler.disable(client.wrapperElement);
        }

        client.connect().catch((error) => {
          autoInitLogger.error("Auto-initialization connect failed:", error);
        });

        // Expose as global for programmatic access
        (window as any).liveTemplateClient = client;
      }
    };

    // Initialize when DOM is ready
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  }

  /**
   * Handle server-sent updates delivered via WebSocket or HTTP fallback.
   */
  private handleWebSocketPayload(
    response: UpdateResponse,
    event?: MessageEvent<string>
  ): void {
    // Check if this is an upload-specific message
    const uploadMessage = response as any;
    if (uploadMessage.type === "upload_progress") {
      this.uploadHandler.handleProgressMessage(
        uploadMessage as UploadProgressMessage
      );
      return;
    }

    // Check if this is an upload_start response
    if (uploadMessage.upload_name && uploadMessage.entries) {
      const startResponse = uploadMessage as UploadStartResponse;
      // Handle upload start response with error handling
      try {
        this.handleUploadStartResponse(startResponse);
      } catch (error) {
        this.logger.error("Error handling upload start response:", error);
      }
      return;
    }

    // Check if this is an upload_complete response
    if (uploadMessage.upload_name && uploadMessage.hasOwnProperty('success')) {
      // UploadCompleteResponse - just log it, no tree update needed
      if (uploadMessage.success) {
        this.logger.info(`Upload complete: ${uploadMessage.upload_name}`);
      } else {
        this.logger.error(`Upload failed: ${uploadMessage.upload_name}`, uploadMessage.error);
      }
      return;
    }

    if (!this.isInitialized) {
      this.loadingIndicator.hide();
      this.formDisabler.enable(this.wrapperElement);
      if (
        this.wrapperElement &&
        this.wrapperElement.hasAttribute("data-lvt-loading")
      ) {
        this.wrapperElement.removeAttribute("data-lvt-loading");
      }
      this.isInitialized = true;
      // Re-run after first render — setupHashLink()'s internal call
      // fired before server content existed in the DOM.
      openFromHash();
    }

    if (this.wrapperElement) {
      if (response.meta?.capabilities) {
        this.changeAutoWirer.setCapabilities(response.meta.capabilities);
      }
      // Analyze statics before updateDOM so wireElements() inside updateDOM
      // has bound fields to work with. Additive: new fields from conditionally
      // rendered templates are detected as they appear in updates.
      this.changeAutoWirer.analyzeStatics(response.tree);

      this.updateDOM(this.wrapperElement, response.tree, response.meta);
      this.messageCount++;

      this.wrapperElement.dispatchEvent(
        new CustomEvent("lvt:updated", {
          detail: {
            messageCount: this.messageCount,
            action: response.meta?.action,
            success: response.meta?.success,
          },
        })
      );
    }
  }

  /**
   * Connect to WebSocket and start receiving updates
   * @param wrapperSelector - CSS selector for the LiveTemplate wrapper (defaults to '[data-lvt-id]')
   */
  async connect(wrapperSelector: string = "[data-lvt-id]"): Promise<void> {
    // Find the wrapper element
    this.wrapperElement = document.querySelector(wrapperSelector);
    if (!this.wrapperElement) {
      throw new Error(
        `LiveTemplate wrapper not found with selector: ${wrapperSelector}`
      );
    }

    this.webSocketManager.disconnect();

    const connectionResult = await this.webSocketManager.connect();
    this.useHTTP = !connectionResult.usingWebSocket;

    if (this.useHTTP) {
      this.ws = null;
      this.logger.info("WebSocket not available, using HTTP mode");
      this.options.onConnect?.();
      if (connectionResult.initialState && this.wrapperElement) {
        this.handleWebSocketPayload(connectionResult.initialState);
      }
    }
    // Set up event delegation for lvt-* attributes
    this.eventDelegator.setupEventDelegation();

    // Set up window-* event delegation
    this.eventDelegator.setupWindowEventDelegation();

    // Set up click-away delegation
    this.eventDelegator.setupClickAwayDelegation();

    // Set up DOM event trigger delegation for lvt-el:*:on:{event} attributes
    this.eventDelegator.setupDOMEventTriggerDelegation();

    // Set up click-outside listener for client-managed toast stack
    setupToastClickOutside();

    // Set up focus trap delegation for lvt-focus-trap attribute
    this.eventDelegator.setupFocusTrapDelegation();

    // Set up autofocus delegation for lvt-autofocus attribute
    this.eventDelegator.setupAutofocusDelegation();

    // Set up link interception for SPA navigation
    this.linkInterceptor.setup(this.wrapperElement);

    // Set up reactive attribute listeners for lvt-el:*:on:* attributes
    setupReactiveAttributeListeners();

    setupInvokerPolyfill();
    setupHashLink();

    // Set up lifecycle listeners for lvt-fx:*:on:{lifecycle} attributes
    setupFxLifecycleListeners(this.wrapperElement);

    // Initialize focus tracking
    this.focusManager.attach(this.wrapperElement);

    // Set up infinite scroll observers
    this.observerManager.setupInfiniteScrollObserver();
    this.observerManager.setupInfiniteScrollMutationObserver();

    this.setupVisibilityReconnect();
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect(): void {
    this.webSocketManager.disconnect();
    this.ws = null;
    this.useHTTP = false;
    this.hiddenAt = 0;
    this.reconnecting = false;
    this.teardownVisibilityReconnect();
    this.eventDelegator.teardownDOMEventTriggerDelegation();
    teardownHashLink();
    if (this.wrapperElement) {
      teardownFxDOMEventTriggers(this.wrapperElement);
      teardownFxLifecycleListeners(this.wrapperElement);
      teardownScrollAway(this.wrapperElement);
    }
    this.resetSessionState();
  }

  // resetSessionState clears all per-session manager state. Called by both
  // disconnect() (with additional transport/event teardown) and reset().
  // Essential for cross-handler SPA navigation: without treeRenderer.reset(),
  // accumulated tree state from the old handler merges into the new one.
  //
  // Note on isInitialized: setting this to false is intentional and is
  // a behavioral change from the prior reset() which left it sticky.
  // The prior behavior was an inconsistency — "reset" that didn't
  // actually put the client in a pre-init state. After reset, the next
  // payload is treated as an initial render: loading indicator shows,
  // forms are enabled, data-lvt-loading is removed. This matches the
  // post-disconnect contract and the documented "useful for testing"
  // intent — tests can observe the init transition a second time.
  private resetSessionState(): void {
    this.treeRenderer.reset();
    this.rangeDomApplier.invalidate();
    this.focusManager.reset();
    this.observerManager.teardown();
    this.changeAutoWirer.teardown();
    this.formLifecycleManager.reset();
    this.loadingIndicator.hide();
    this.formDisabler.enable(this.wrapperElement);
    this.lvtId = null;
    this.isInitialized = false;
  }

  private setupVisibilityReconnect(): void {
    if (this.visibilityHandlerAttached || typeof document === "undefined") return;
    this.visibilityHandlerAttached = true;

    this.visibilityHandler = () => {
      if (document.hidden) {
        // Only track hidden time if WebSocket is currently open.
        // Prevents stale handlers from triggering reconnection on
        // already-disconnected clients (e.g. after cross-handler
        // navigation or explicit disconnect).
        if (!this.useHTTP && this.webSocketManager.getReadyState() === 1) {
          this.hiddenAt = Date.now();
        }
        return;
      }
      if (this.hiddenAt === 0) return;
      const elapsed = Date.now() - this.hiddenAt;
      this.hiddenAt = 0;
      if (elapsed < 3000) return;
      this.scheduleVisibilityReconnect();
    };

    // pageshow's persisted=true means the page came back from bfcache —
    // its in-memory connection state is unknown, so reconnect unconditionally
    // (no 3s threshold). visibilitychange handles ordinary tab-switch cases.
    this.pageshowHandler = (event: PageTransitionEvent) => {
      if (event.persisted) {
        this.scheduleVisibilityReconnect();
      }
    };

    document.addEventListener("visibilitychange", this.visibilityHandler);
    window.addEventListener("pageshow", this.pageshowHandler);
  }

  private teardownVisibilityReconnect(): void {
    if (this.visibilityReconnectTimer !== null) {
      clearTimeout(this.visibilityReconnectTimer);
      this.visibilityReconnectTimer = null;
    }
    if (!this.visibilityHandlerAttached || typeof document === "undefined") return;
    if (this.visibilityHandler) {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = null;
    }
    if (this.pageshowHandler) {
      window.removeEventListener("pageshow", this.pageshowHandler);
      this.pageshowHandler = null;
    }
    this.visibilityHandlerAttached = false;
  }

  private scheduleVisibilityReconnect(): void {
    // 500ms delay lets onclose deliver before we ask for a new socket.
    // Tracked on the instance so teardownVisibilityReconnect() can
    // cancel a pending timer when disconnect() runs mid-window —
    // otherwise a timer queued before disconnect can fire after a
    // subsequent connect on the same instance and trigger an
    // unwanted reconnect.
    //
    // Cancel any in-flight timer first so a rapid
    // visibilitychange+pageshow sequence doesn't leak the earlier
    // setTimeout (the tracked ref would only point at the last one,
    // leaving the first orphaned).
    if (this.visibilityReconnectTimer !== null) {
      clearTimeout(this.visibilityReconnectTimer);
    }
    this.visibilityReconnectTimer = setTimeout(() => {
      this.visibilityReconnectTimer = null;
      // Guard: only reconnect if a WebSocket transport exists. After
      // disconnect(), transport is null (readyState undefined) so we
      // correctly skip intentionally disconnected clients.
      // Note: we intentionally do NOT check readyState !== 1 (OPEN)
      // because iOS 15+ can leave zombie sockets that report OPEN while
      // the underlying TCP connection is dead. Always reconnecting after
      // a long background is cheap (morphdom diffs produce no DOM changes
      // on a healthy connection) and handles the zombie case.
      if (
        this.wrapperElement &&
        !this.useHTTP &&
        !this.reconnecting &&
        this.webSocketManager.getReadyState() !== undefined
      ) {
        this.performVisibilityReconnect();
      }
    }, 500);
  }

  private async performVisibilityReconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;

    try {
      this.logger.info("Reconnecting after visibility change");

      this.webSocketManager.disconnect();
      this.ws = null;
      this.resetSessionState();

      const result = await this.webSocketManager.connect();

      // disconnect() may have run during the await above. It clears the
      // reconnecting flag, so the absence of that flag here is our
      // "torn down while suspended" signal — abort without mutating
      // state. Without this, useHTTP / payload application would land
      // on a client the consumer expects to be inert (or, worse, on a
      // freshly-reconnected client created by a subsequent connect()).
      if (!this.reconnecting) return;

      this.useHTTP = !result.usingWebSocket;

      if (this.useHTTP) {
        this.ws = null;
        if (result.initialState && this.wrapperElement) {
          this.handleWebSocketPayload(result.initialState);
        }
      }

      this.wrapperElement?.dispatchEvent(new Event("lvt:reconnected"));
    } catch (err) {
      this.logger.error("Visibility reconnect failed:", err);
    } finally {
      this.reconnecting = false;
    }
  }

  /**
   * Clear flash-related query parameters (error, success) from the URL.
   * This prevents stale flash messages from reappearing on page reload.
   * Uses history.replaceState to update URL without triggering navigation.
   */
  private clearFlashQueryParams(): void {
    const url = new URL(window.location.href);
    const flashParams = ["error", "success"];
    let hasFlashParams = false;

    for (const param of flashParams) {
      if (url.searchParams.has(param)) {
        url.searchParams.delete(param);
        hasFlashParams = true;
      }
    }

    if (hasFlashParams) {
      this.logger.debug("Clearing flash query params from URL");
      window.history.replaceState(null, "", url.toString());
    }
  }

  /**
   * Determine whether the client finished its initial load and has an active transport.
   */
  isReady(): boolean {
    const wrapper = this.wrapperElement;

    if (!wrapper || wrapper.hasAttribute("data-lvt-loading")) {
      return false;
    }

    if (this.useHTTP) {
      return true;
    }

    const readyState = this.webSocketManager.getReadyState();
    return readyState === 1; // WebSocket.OPEN = 1
  }

  /**
   * Send a message to the server via WebSocket or HTTP
   * @param message - Message to send (will be JSON stringified)
   */
  send(message: any): void {
    const readyState = this.webSocketManager.getReadyState();

    if (this.logger.isDebugEnabled()) {
      this.logger.debug("send() invoked", {
        message,
        useHTTP: this.useHTTP,
        hasWebSocket: readyState !== undefined,
        readyState,
      });
    }

    if (this.useHTTP) {
      this.logger.debug("Using HTTP mode for send");
      this.sendHTTP(message);
    } else if (readyState === 1) { // WebSocket.OPEN = 1
      this.logger.debug("Sending via WebSocket");
      this.webSocketManager.send(JSON.stringify(message));
    } else if (readyState !== undefined) {
      this.logger.warn(
        `WebSocket not ready (state: ${readyState}), using HTTP fallback`
      );
      this.sendHTTP(message);
    } else {
      this.logger.error("No transport available");
    }
  }

  /**
   * Get the current live URL for HTTP methods. Falls back to
   * options.liveUrl when no override is set. Cross-handler navigation
   * uses setLiveUrl() to update the override without mutating options.
   */
  private getLiveUrl(): string {
    return this.liveUrlOverride || this.options.liveUrl || "/live";
  }

  /**
   * Send an in-band navigate message over the existing WebSocket.
   *
   * This is the client side of the same-handler SPA navigation flow.
   * Rather than disconnect + reconnect to land a URL change (which is
   * what cross-handler nav does and what the old same-handler path
   * silently skipped), we parse the target URL's query params into a
   * data map and send {action: "__navigate__", data: params}. The
   * server special-cases this action name in its event loop (see
   * livetemplate/mount.go) and re-runs Mount with the new data without
   * tearing down the connection.
   *
   * Equivalent to Phoenix LiveView's live_patch / handle_params:
   * path-level identity for the socket, Mount-level re-projection for
   * query-string changes.
   *
   * @param href - The target URL to navigate to. Only the search params
   *               are consumed; the pathname is assumed to match the
   *               current page (caller checks same-handler first).
   */
  private sendNavigate(href: string): boolean {
    const url = new URL(href, window.location.origin);
    const data: Record<string, string> = {};
    // Note: duplicate keys (e.g. ?tag=a&tag=b) are last-write-wins here.
    // LiveTemplate routes use scalar string params by convention. Routes
    // that need repeated params should not use sendNavigate directly.
    const seenKeys = new Set<string>();
    url.searchParams.forEach((v, k) => {
      if (seenKeys.has(k)) {
        this.logger.warn("sendNavigate: duplicate query param key — last value wins; server may receive incomplete data", { key: k, href });
      }
      seenKeys.add(k);
      data[k] = v;
    });

    const newLiveUrl = url.pathname + url.search;

    // __navigate__ is a WebSocket-only in-band action — only call send()
    // when the socket is actually OPEN.
    //
    // Note: this.useHTTP is not checked here because sendNavigate() is only
    // reachable when canSendNavigate() returns true (i.e. !this.useHTTP and
    // readyState === 1), enforced by LinkInterceptor. Checking useHTTP or
    // re-checking readyState here would be dead code in the normal call path.
    // The guard below is a defensive fallback for direct callers that bypass
    // canSendNavigate().
    if (this.webSocketManager.getReadyState() !== 1 /* WebSocket.OPEN */) {
      const readyState = this.webSocketManager.getReadyState();
      if (readyState === 3 /* CLOSED */) {
        this.logger.error(
          "sendNavigate: WebSocket is CLOSED and autoReconnect may be disabled; " +
          "navigate message dropped. Reload or re-enable autoReconnect.",
          { href }
        );
      } else {
        // CONNECTING (0) or CLOSING (2). autoReconnect defaults to false.
        if (!this.options.autoReconnect) {
          this.logger.error(
            "sendNavigate: WS not open and autoReconnect is disabled; navigate may be permanently lost",
            { href, readyState }
          );
        } else {
          this.logger.warn(
            "sendNavigate: WS not open; browser URL is ahead of server state until reconnect",
            { href, readyState }
          );
        }
      }
      return false;
    }

    // Socket is OPEN: commit the URL update and send the navigate message.
    // liveUrlOverride is updated here (not before the guard) so it only
    // advances when the message is actually sent — keeping it consistent
    // with window.location throughout.
    this.liveUrlOverride = newLiveUrl;
    this.webSocketManager.setLiveUrl(newLiveUrl);
    this.logger.debug("sendNavigate", { href, data });
    this.send({ action: "__navigate__", data });
    return true;
  }

  /**
   * Send action via HTTP POST
   */
  private async sendHTTP(message: any): Promise<void> {
    try {
      const liveUrl = this.getLiveUrl();
      const response = await fetch(liveUrl, {
        method: "POST",
        credentials: "include", // Include cookies for session
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(message),
      });

      if (!response.ok) {
        throw new Error(`HTTP request failed: ${response.status}`);
      }

      // Handle the update response
      const updateResponse: UpdateResponse = await response.json();
      if (this.wrapperElement) {
        this.updateDOM(
          this.wrapperElement,
          updateResponse.tree,
          updateResponse.meta
        );
      }
    } catch (error) {
      this.logger.error("Failed to send HTTP request:", error);
    }
  }

  /**
   * Send form with file inputs via HTTP POST multipart/form-data.
   * Used for Tier 1 file uploads where binary files are submitted via
   * HTTP fetch instead of WebSocket (avoids base64 encoding overhead).
   *
   * IMPORTANT: Callers must pass pre-captured form data (formData).
   * FormData must be built BEFORE setActiveSubmission disables the
   * form's fieldset — otherwise FormData would be empty because
   * disabled fieldsets exclude all child fields. The caller is also
   * responsible for setting the "lvt-action" entry; this method will
   * not mutate the passed FormData.
   */
  sendHTTPMultipart(form: HTMLFormElement, action: string, formData: FormData): void {
    this.doSendHTTPMultipart(form, action, formData);
  }

  private async doSendHTTPMultipart(
    form: HTMLFormElement,
    action: string,
    formData: FormData
  ): Promise<void> {
    try {
      const liveUrl = this.getLiveUrl();

      const response = await fetch(liveUrl, {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json",
          // Do NOT set Content-Type — browser sets multipart boundary automatically
        },
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`HTTP multipart request failed: ${response.status}`);
      }

      const updateResponse: UpdateResponse = await response.json();
      if (this.wrapperElement) {
        this.updateDOM(
          this.wrapperElement,
          updateResponse.tree,
          updateResponse.meta
        );
      }
    } catch (error) {
      this.logger.error("Failed to send HTTP multipart request:", error);
    }
  }

  /**
   * Handle navigation response from link interception.
   * Extracts the wrapper content from the full HTML page and replaces
   * the current wrapper content. Content comes from same-origin fetch
   * responses only (link interceptor skips external origins).
   *
   * Supports both same-handler navigation (same data-lvt-id) and
   * cross-handler navigation (different data-lvt-id). Cross-handler
   * navigation disconnects the old WebSocket, replaces the wrapper
   * content and ID, and reconnects to the new handler. The URL must
   * already be updated via pushState before this method is called
   * (done in LinkInterceptor.navigate) so the WebSocket connects to
   * the correct handler.
   */
  private handleNavigationResponse(html: string): void {
    if (!this.wrapperElement) return;

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const oldId = this.wrapperElement.getAttribute("data-lvt-id");

    // Update document title from the fetched page. Only apply if the
    // new title is non-empty — blanking the title would be surprising
    // and unhelpful.
    const newTitleText = doc.querySelector("title")?.textContent;
    if (newTitleText) {
      document.title = newTitleText;
    }

    // sameWrapper: the fetched page has the same data-lvt-id as the current
    // wrapper. This means two different paths share the same handler ID.
    // handleNavigationResponse is only reached via LinkInterceptor for
    // cross-pathname navigations (same-pathname links are caught by the fast
    // path before a fetch is issued and handled via sendNavigate directly).
    // For cross-pathname same-ID, a full reconnect is correct: the server
    // must receive the new URL to re-run Mount on the right route. We fall
    // through to the newWrapper block below, which handles both same-ID and
    // different-ID handler switches identically.
    //
    // Same-pathname same-ID navigation (query-param change on the same route)
    // is covered exclusively by LinkInterceptor's fast path and navigate.test.ts.

    // Check for any handler wrapper (same-ID cross-path or different handler)
    const newWrapper = doc.querySelector("[data-lvt-id]");
    if (newWrapper) {
      const newId = newWrapper.getAttribute("data-lvt-id");
      // Guard: attribute exists (we queried by [data-lvt-id]) but could be empty
      if (!newId) {
        this.logger.warn("Cross-handler navigation: new wrapper has empty data-lvt-id");
        window.location.reload();
        return;
      }

      // Clean up stale event listeners keyed to the old wrapper ID.
      // Each component knows its own listener keys, so we delegate.
      this.linkInterceptor.teardownForWrapper(oldId);
      this.eventDelegator.teardownForWrapper(oldId);

      // Supersede any previous in-flight connect() from an earlier navigation
      const myEpoch = ++this.navigationEpoch;

      this.disconnect();
      this.wrapperElement.setAttribute("data-lvt-id", newId);
      this.wrapperElement.replaceChildren(
        ...Array.from(newWrapper.childNodes).map((n) => n.cloneNode(true))
      );

      // Set up event delegation and link interception immediately so the
      // new content has working listeners BEFORE the async connect() runs.
      // connect() will re-run these internally, which is safe: both setup
      // methods are idempotent — they remove any existing listener with
      // the same key before adding the new one. Calling them twice in
      // quick succession results in a single active listener per event
      // type per wrapper ID.
      this.eventDelegator.setupEventDelegation();
      this.linkInterceptor.setup(this.wrapperElement);

      // Scroll to top for cross-handler navigation
      window.scrollTo(0, 0);

      // Update the live URL used by HTTP methods AND the WebSocket
      // manager to derive the reconnect path. We use private overrides
      // on both so the caller-provided options object is never mutated.
      // Hash fragments are intentionally excluded — the WebSocket path
      // comes from pathname+search only.
      //
      // liveUrl convention: it is always the CURRENT PAGE PATH, not a
      // separate endpoint. Each LiveTemplate handler route is both the
      // HTTP page and the WebSocket endpoint for that handler, so the
      // page path and the WebSocket path are always the same. Apps that
      // need a different WebSocket endpoint should set `wsUrl`, which
      // takes precedence over `liveUrl` in WebSocketManager.
      //
      // Invariant: link-interceptor.ts calls pushState BEFORE invoking
      // handleNavigationResponse, so window.location here always
      // reflects the final target URL (not the previous one). This is
      // why liveUrlOverride is never stale for cross-pathname navigations
      // even if sendNavigate had previously set it to a same-pathname URL.
      const newLiveUrl =
        window.location.pathname + window.location.search;
      this.liveUrlOverride = newLiveUrl;
      this.webSocketManager.setLiveUrl(newLiveUrl);

      // In HTTP mode there is no persistent WebSocket connection — skip
      // connect() so we don't unexpectedly create a WebSocket. The DOM swap
      // and event re-setup above are sufficient for HTTP-mode apps; the next
      // user action will POST via the normal HTTP send path.
      if (!this.useHTTP) {
        // Reconnect to the new handler. The server sends an initial tree
        // that produces the same DOM as the fetched HTML.
        //
        // Escape the wrapper ID to defend against (pathological) server
        // responses with special characters that would break the
        // attribute selector. Only `"` and `\` need escaping inside a
        // double-quoted attribute value selector (`[attr="..."]`), and
        // we prefer a manual escape over CSS.escape() which is not
        // available in jsdom test environments.
        //
        // Epoch semantics: the failure branch is guarded by the epoch
        // check to avoid stale reloads. The success branch has no work
        // to do — there's nothing for handleNavigationResponse to undo
        // on success.
        //
        // Known limitation: if two cross-handler navigations run in rapid
        // succession (A then B), A's connect() might still be executing
        // its post-await setup (useHTTP assignment, initial state
        // rendering, event delegation) when B starts. Because there's
        // only one WebSocketManager transport at a time, B's disconnect()
        // kills A's in-flight transport, and B's setup happens on the
        // wrapper with B's ID. If A's post-await code runs AFTER B sets
        // the wrapper ID, A's querySelector lookup would already be
        // stale (it captured the wrapper synchronously before the await).
        // A true fix requires making connect() itself cancellable with
        // an AbortSignal, which is out of scope for this PR. In practice,
        // two successive SPA navigations within a single event loop tick
        // are rare, and the idempotent setup methods minimize fallout.
        const escapedId = newId.replace(/[\\"]/g, "\\$&");
        const selector = `[data-lvt-id="${escapedId}"]`;
        this.connect(selector).catch((err) => {
          if (myEpoch !== this.navigationEpoch) return;
          this.logger.error("Cross-handler reconnect failed:", err);
          window.location.reload();
        });
      }
      return;
    }

    // Non-LiveTemplate page — disconnect the old WebSocket (it's pointing
    // to a handler whose DOM is about to be replaced) and tear down the
    // old listeners keyed to the previous wrapper ID, then use body
    // content fallback.
    this.linkInterceptor.teardownForWrapper(oldId);
    this.eventDelegator.teardownForWrapper(oldId);
    this.disconnect();
    const body = doc.querySelector("body");
    if (body) {
      this.wrapperElement.replaceChildren(
        ...Array.from(body.childNodes).map((n) => n.cloneNode(true))
      );
    }
    this.eventDelegator.setupEventDelegation();
    this.linkInterceptor.setup(this.wrapperElement);
  }

  /**
   * Parse a string value into appropriate type (number, boolean, or string)
   * @param value - String value to parse
   * @returns Parsed value with correct type
   */
  private parseValue(value: string): any {
    // Trim once for consistent handling
    const trimmed = value.trim();

    // Try to parse as number
    const num = parseFloat(trimmed);
    if (!isNaN(num)) {
      // Check range FIRST - large integers (like UnixNano timestamps) must stay as strings
      // to preserve precision. JavaScript's Number can only safely represent integers
      // up to 2^53-1 (MAX_SAFE_INTEGER = 9,007,199,254,740,991).
      if (Number.isInteger(num) && Math.abs(num) > Number.MAX_SAFE_INTEGER) {
        return trimmed;
      }
      // Only convert to number if string representation matches (no precision loss)
      if (trimmed === num.toString()) {
        return num;
      }
    }

    // Try to parse as boolean
    if (value === "true") return true;
    if (value === "false") return false;

    // Return as string
    return value;
  }

  /**
   * Apply an update to the current state and reconstruct HTML
   * @param update - Tree update object from LiveTemplate server
   * @returns Reconstructed HTML and whether anything changed
   */
  applyUpdate(update: TreeNode): UpdateResult {
    return this.treeRenderer.applyUpdate(update);
  }

  /**
   * Apply updates to existing HTML using morphdom for efficient DOM updates
   * @param existingHTML - Current full HTML document
   * @param update - Tree update object from LiveTemplate server
   * @returns Updated HTML content
   */
  applyUpdateToHTML(existingHTML: string, update: TreeNode): string {
    // Apply the update to our internal state
    const result = this.applyUpdate(update);

    // Extract lvt-id from existing HTML if we don't have it
    if (!this.lvtId) {
      const match = existingHTML.match(/data-lvt-id="([^"]+)"/);
      if (match) {
        this.lvtId = match[1];
      }
    }

    // The new tree includes complete HTML structure, so we can reconstruct properly
    const innerContent = result.html;

    // Find where to insert the reconstructed content
    const bodyMatch = existingHTML.match(/<body>([\s\S]*?)<\/body>/);
    if (!bodyMatch) {
      return existingHTML;
    }

    // Replace the body content with our reconstructed HTML
    // We need to preserve the wrapper div with data-lvt-id
    const wrapperStart = `<div data-lvt-id="${this.lvtId || "lvt-unknown"}">`;
    const wrapperEnd = "</div>";
    const newBodyContent = wrapperStart + innerContent + wrapperEnd;

    return existingHTML.replace(
      /<body>[\s\S]*?<\/body>/,
      `<body>${newBodyContent}</body>`
    );
  }

  /**
   * Update a live DOM element with new tree data
   * @param element - DOM element containing the LiveTemplate content (the wrapper div)
   * @param update - Tree update object from LiveTemplate server
   * @param meta - Optional metadata about the update (action, success, errors)
   */
  updateDOM(element: Element, update: TreeNode, meta?: ResponseMetadata): void {
    // Reset per-render counters before applying the update.
    // - nodesAddedThisRender: incremented by morphdom.onNodeAdded and the
    //   applier's onNodeAdded callback for i/a/p ops.
    // - directiveTouchedThisRender: set by morphdom.onBeforeElUpdated when
    //   it processes an element carrying a directive attribute (lvt-fx:*,
    //   lvt-on:*, lvt-el:*) — covers attribute-only morphs that don't add
    //   nodes but do change directive bindings, so the post-render scans
    //   still need to wire them.
    // Either signal triggers the wrapper-wide directive scans below.
    this.nodesAddedThisRender = 0;
    this.directiveTouchedThisRender = false;

    // Apply update to internal state and get reconstructed HTML.
    // Pass canApplyTargeted so eligible top-level range diff ops mutate
    // treeState in place and are emitted as targetedOps for direct DOM
    // mutation (skipping the full HTML rebuild + morphdom diff for that
    // subtree).
    const result = this.treeRenderer.applyUpdate(update, {
      canApplyTargeted: (rangeStructure, rangePath) => {
        const r = this.rangeDomApplier.canApplyTargeted(
          element,
          rangeStructure,
          rangePath
        );
        return r.ok;
      },
    });

    // Helper to recursively check if there are any statics in the tree
    const hasStaticsInTree = (node: any): boolean => {
      if (!node || typeof node !== "object") return false;
      if (node.s && Array.isArray(node.s)) return true;
      return Object.values(node).some((v) => hasStaticsInTree(v));
    };

    if (!result.changed && !hasStaticsInTree(update)) {
      // No changes detected and no statics in update, skip morphdom
      return;
    }

    // Create a temporary wrapper to hold the new content
    // We need to create a DOM element of the same type as 'element' to avoid browser HTML corrections
    // For example, if we put <tr> elements in a <div>, the browser strips them out
    const tempWrapper = document.createElement(element.tagName);

    if (this.logger.isDebugEnabled()) {
      this.logger.debug("[updateDOM] element.tagName:", element.tagName);
      this.logger.debug(
        "[updateDOM] result.html (first 500 chars):",
        result.html.substring(0, 500)
      );
      this.logger.debug(
        "[updateDOM] Has <table> tag:",
        result.html.includes("<table>")
      );
      this.logger.debug(
        "[updateDOM] Has <tbody> tag:",
        result.html.includes("<tbody>")
      );
      this.logger.debug(
        "[updateDOM] Has <tr> tag:",
        result.html.includes("<tr")
      );
    }

    // Use DOMParser when the HTML contains <script> tags. Browsers'
    // innerHTML parser handles scripts specially and can create phantom
    // duplicate DOM nodes after the closing tag. DOMParser doesn't have
    // this quirk because it returns a standalone document.
    //
    // Regex /<script[\s>]/i is more precise than a bare "<script" string
    // match: it avoids false positives from words ending in "script" that
    // aren't a tag (e.g. "noscript"), while still matching <script>,
    // <script type="..."> and <SCRIPT> case-insensitively.
    // Note: it can still match <script inside attribute values or HTML
    // comments — a false positive is harmless (DOMParser is always safe;
    // we just pay a small allocation cost for the parse).
    //
    // Wrap with the same tagName as the target element (not a hard-coded
    // <div>) so that DOMParser applies the correct HTML parsing rules.
    // Wrapping <tr>/<td>/<option> content in a <div> can trigger
    // browser re-parenting; using the real container tag avoids that.
    if (/<script[\s>]/i.test(result.html)) {
      // Guard: <body> and <html> cannot be used as wrapper tags for
      // parseFromString — doc.body.firstElementChild would return the
      // first child of body, not the body itself, discarding the wrap.
      // Fall back to <div> for these edge cases; updateDOM is called on
      // the lvt wrapper div in practice, so this branch is defensive.
      const rawTag = element.tagName.toLowerCase();
      const wrapTag = (rawTag === "body" || rawTag === "html") ? "div" : rawTag;
      const parser = new DOMParser();
      const doc = parser.parseFromString(
        `<${wrapTag}>${result.html}</${wrapTag}>`,
        "text/html"
      );
      const root = doc.body.firstElementChild;
      if (root) {
        // Array.from snapshots the live NodeList before replaceChildren
        // starts moving nodes, keeping iteration stable.
        //
        // Note: DOMParser still re-parents bare table-cell content (tr/td
        // without surrounding table+tbody) even when wrapTag matches.
        // Slots rendered into table-cell elements with <script> tags are
        // an edge case; a follow-up can add a full-table wrapper for those.
        tempWrapper.replaceChildren(...Array.from(root.childNodes));
      } else {
        // root is null when the HTML parser produced no element child for
        // our wrapper tag (e.g. the wrapper was itself re-parented or the
        // fragment is text-only). Fall back to doc.body children — the
        // content is still present there, already parsed by DOMParser
        // without the script-duplication quirk that innerHTML triggers.
        this.logger.warn("[updateDOM] DOMParser: no wrapper root element; using doc.body children");
        tempWrapper.replaceChildren(...Array.from(doc.body.childNodes));
      }
    } else {
      tempWrapper.innerHTML = result.html;
    }

    if (this.logger.isDebugEnabled()) {
      this.logger.debug(
        "[updateDOM] tempWrapper.innerHTML (first 500 chars):",
        tempWrapper.innerHTML.substring(0, 500)
      );
      this.logger.debug(
        "[updateDOM] tempWrapper has <table>:",
        tempWrapper.innerHTML.includes("<table>")
      );
      this.logger.debug(
        "[updateDOM] tempWrapper has <tbody>:",
        tempWrapper.innerHTML.includes("<tbody>")
      );
      this.logger.debug(
        "[updateDOM] tempWrapper has <tr>:",
        tempWrapper.innerHTML.includes("<tr")
      );
    }

    // Defer the entire morphdom pass while a native datalist dropdown
    // may be showing. Datalist popups are browser-managed overlays with
    // no DOM representation — ANY mutation on the page (not just to the
    // datalist itself) triggers a reflow that dismisses the popup.
    // Since there is no API to query whether the popup is open, we use
    // document.activeElement being a datalist-connected <input> as the
    // signal. The deferred state is naturally applied on the next server
    // push after the user leaves the input (typically within one scan
    // interval).
    const activeEl = document.activeElement;
    if (
      activeEl instanceof HTMLInputElement &&
      activeEl.list instanceof HTMLDataListElement &&
      !tempWrapper.querySelector("[data-lvt-force-update]")
    ) {
      this.logger.debug("[updateDOM] deferred: datalist input focused");
      this.focusManager.restoreFocusedElement();
      return;
    }

    // Build morphdom options once so the applier's `u` op (which morphdoms
    // a single row) uses the same callback set — focus skip, lvt-ignore,
    // checkbox preservation, lifecycle hooks all stay consistent.
    const morphdomOptions = {
      childrenOnly: true, // Only update children, preserve the wrapper element itself
      getNodeKey: (node: any) => {
        // Use data-key or data-lvt-key for efficient reconciliation
        if (node.nodeType === 1) {
          return (
            node.getAttribute("data-key") ||
            node.getAttribute("data-lvt-key") ||
            undefined
          );
        }
      },
      onBeforeElUpdated: (fromEl: any, toEl: any) => {
        // Targeted-apply skip: the live container's children were already
        // mutated directly by RangeDomApplier, and the rebuilt tempWrapper
        // has the container empty + tagged with data-lvt-targeted-skip.
        // Returning false short-circuits the entire subtree update —
        // morphdom skips both the diff walk AND the children-replacement.
        if (
          toEl.nodeType === Node.ELEMENT_NODE &&
          (toEl as Element).hasAttribute(TARGETED_SKIP_ATTR)
        ) {
          return false;
        }

        // Track newly-introduced directive attributes so the post-render
        // scan can wire any new lvt-fx:/lvt-on:/lvt-el: bindings even on
        // renders that wouldn't otherwise trigger a wrapper-wide scan.
        // Only flag when the directive attribute is NEW on toEl (not
        // already present on fromEl) — otherwise high-frequency `u` ops
        // on rows that ALREADY carry a directive (e.g. Todos rows with
        // `lvt-fx:animate`) would trigger a wrapper-wide scan on every
        // render even though no new binding needs wiring.
        if (
          toEl.nodeType === Node.ELEMENT_NODE &&
          fromEl.nodeType === Node.ELEMENT_NODE
        ) {
          const toAttrs = (toEl as Element).attributes;
          const fromElement = fromEl as Element;
          for (let i = 0; i < toAttrs.length; i++) {
            const n = toAttrs[i].name;
            if (
              n.length > 4 &&
              n.charCodeAt(0) === 0x6c /* l */ &&
              n.charCodeAt(1) === 0x76 /* v */ &&
              n.charCodeAt(2) === 0x74 /* t */ &&
              n.charCodeAt(3) === 0x2d /* - */ &&
              !fromElement.hasAttribute(n)
            ) {
              this.directiveTouchedThisRender = true;
              break;
            }
          }
        }

        // lvt-ignore: morphdom skips this element and its entire subtree.
        // Equivalent to Phoenix LiveView's phx-update="ignore".
        // Checked on fromEl (live DOM) so both server templates and
        // client JS can add/remove it. Use data-lvt-force-update on
        // the server's version to bypass and resume diffing.
        if (
          fromEl.nodeType === Node.ELEMENT_NODE &&
          (fromEl as Element).hasAttribute("lvt-ignore") &&
          !(toEl as Element).hasAttribute("data-lvt-force-update")
        ) {
          return false;
        }

        // lvt-ignore-attrs: skip attribute diffing but still diff children.
        // Copies fromEl's missing attributes onto toEl so morphdom keeps
        // them. Server-set attributes still win (toEl value used when
        // both sides have the same attr). Checked on fromEl for
        // consistency with lvt-ignore; use data-lvt-force-update to
        // bypass.
        if (
          fromEl.nodeType === Node.ELEMENT_NODE &&
          (fromEl as Element).hasAttribute("lvt-ignore-attrs") &&
          !(toEl as Element).hasAttribute("data-lvt-force-update") &&
          toEl.nodeType === Node.ELEMENT_NODE
        ) {
          const fromAttrs = (fromEl as Element).attributes;
          const toElement = toEl as Element;
          for (let i = 0; i < fromAttrs.length; i++) {
            const attr = fromAttrs[i];
            if (!toElement.hasAttributeNS(attr.namespaceURI, attr.localName)) {
              toElement.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
            }
          }
        }

        // Preserve <datalist> elements while their connected input is
        // focused. Native datalist dropdowns are dismissed if the element
        // is touched — unlike checkbox state, dropdown-open state has no
        // DOM representation and cannot be copied to the new element.
        if (
          fromEl instanceof HTMLDataListElement &&
          !(toEl as Element).hasAttribute('data-lvt-force-update')
        ) {
          const active = document.activeElement;
          if (
            active instanceof HTMLInputElement &&
            active.list === fromEl
          ) {
            return false;
          }
        }

        // Copy `open` onto toEl so morphdom's attr sync won't strip it (preserves top-layer state).
        if (
          fromEl instanceof HTMLDialogElement &&
          fromEl.hasAttribute('open') &&
          !(toEl as Element).hasAttribute('data-lvt-force-update')
        ) {
          (toEl as Element).setAttribute('open', '');
        }

        // Skip open popovers entirely (top-layer state has no DOM representation).
        if (
          !(toEl as Element).hasAttribute("data-lvt-force-update") &&
          fromEl instanceof HTMLElement &&
          fromEl.hasAttribute("popover") &&
          safeMatchesPopoverOpen(fromEl)
        ) {
          return false;
        }

        // Preserve checkbox/radio checked state across morphdom updates.
        // User selection wins by default — these controls lose focus on
        // click so the focusManager never protects them, and their checked
        // state is user input that must survive scan-loop refreshes. Use
        // data-lvt-force-update to let the server override the user state.
        //
        // Known limitation: force-update on one radio can uncheck a sibling
        // that was already processed earlier in the same morphdom pass, since
        // browser mutual exclusion fires synchronously mid-loop. To safely
        // reset a radio group, send data-lvt-force-update on ALL radios in
        // the group, not just the one being checked.
        if (
          fromEl instanceof HTMLInputElement &&
          toEl instanceof HTMLInputElement &&
          (fromEl.type === "checkbox" || fromEl.type === "radio")
        ) {
          if (toEl.hasAttribute("data-lvt-force-update")) {
            fromEl.checked = toEl.checked;
            if (fromEl.type === "checkbox") {
              fromEl.indeterminate = toEl.indeterminate;
            }
            fromEl.removeAttribute("data-lvt-force-update");
          } else {
            toEl.checked = fromEl.checked;
            // Align the checked attribute with the property so morphdom's
            // attribute diff doesn't add a spurious checked attr to fromEl
            // (which IS in the DOM and would trigger radio mutual exclusion).
            if (fromEl.checked) {
              toEl.setAttribute("checked", "");
            } else {
              toEl.removeAttribute("checked");
            }
            if (fromEl.type === "checkbox") {
              toEl.indeterminate = fromEl.indeterminate;
            }
          }
        }

        // Skip update entirely for focused form elements to preserve user
        // input. This also skips attribute updates (class, disabled, aria-*)
        // and the lvt-updated hook — use data-lvt-force-update to override.
        if (this.focusManager.shouldSkipUpdate(fromEl)) {
          return false;
        }

        // Only update if content actually changed — but honour
        // data-lvt-force-update which means the server wants morphdom
        // to process this element or one of its descendants
        // unconditionally (e.g. resetting a checkbox whose checked
        // property differs from the attribute).
        // Note: querySelector is a defensive fallback — in steady state
        // the attr is stripped after each render, so isEqualNode returns
        // false and normal diffing reaches the descendant. The scan only
        // matters on the first render of a newly inserted subtree.
        if (fromEl.isEqualNode(toEl)) {
          if (
            !toEl.hasAttribute("data-lvt-force-update") &&
            (toEl.children.length === 0 ||
              toEl.querySelector("[data-lvt-force-update]") === null)
          ) {
            return false;
          }
          // Ancestor itself didn't change — only traversing for a
          // descendant's force-update. Skip the lvt-updated hook.
          return true;
        }
        // Execute lvt-updated lifecycle hook
        this.executeLifecycleHook(fromEl, "lvt-updated");
        return true;
      },
      onElUpdated: (el: any) => {
        // Textarea-specific: morphdom patches child text nodes but browsers
        // ignore textContent changes to "dirty" textareas (ones the user
        // has typed in), so we explicitly set .value. Inputs don't need
        // this — morphdom sets .value directly for input elements.
        if (el instanceof HTMLTextAreaElement) {
          el.value = el.textContent ?? "";
        }
        // Strip data-lvt-force-update from the live DOM after each
        // render. If the server stops sending it, preservation resumes;
        // if the server keeps including it, each render force-resets.
        if (el instanceof HTMLElement && el.hasAttribute("data-lvt-force-update")) {
          el.removeAttribute("data-lvt-force-update");
        }
      },
      onNodeAdded: (node: any) => {
        // Sync textarea value for newly inserted textarea elements
        if (node instanceof HTMLTextAreaElement) {
          node.value = node.textContent ?? "";
        }
        if (node instanceof HTMLElement && node.hasAttribute("data-lvt-force-update")) {
          node.removeAttribute("data-lvt-force-update");
        }
        // Execute lvt-mounted lifecycle hook
        if (node.nodeType === Node.ELEMENT_NODE) {
          this.executeLifecycleHook(node as Element, "lvt-mounted");
          this.nodesAddedThisRender++;
        }
      },
      onBeforeNodeDiscarded: (node: any) => {
        // Execute lvt-destroyed lifecycle hook
        if (node.nodeType === Node.ELEMENT_NODE) {
          this.executeLifecycleHook(node as Element, "lvt-destroyed");
        }
        return true;
      },
    };

    // Apply per-op targeted DOM mutations BEFORE morphdom. The applier
    // mutates the live DOM in place; tempWrapper has corresponding
    // <!--lvt-targeted-skip:path--> placeholders that we now convert to
    // data-lvt-targeted-skip markers on their parent elements so morphdom
    // short-circuits those subtrees.
    //
    // Robustness: if any targeted op fails (apply returns null — e.g.
    // container couldn't be located, or an op threw), the treeState was
    // updated but the live DOM wasn't, so leaving the placeholder in
    // place would either (a) tell morphdom to skip → live DOM stays
    // stale, or (b) leave an empty container in tempWrapper → morphdom
    // would empty the live container. Both are wrong. We re-render the
    // full HTML from treeState (which is authoritative) and let morphdom
    // sync from there.
    if (result.targetedOps && result.targetedOps.length > 0) {
      const successContainers: Element[] = [];
      let anyFailed = false;
      for (const op of result.targetedOps) {
        const container = this.rangeDomApplier.apply(
          element,
          op,
          morphdomOptions
        );
        if (container) {
          container.setAttribute(TARGETED_APPLIED_ATTR, "");
          successContainers.push(container);
        } else {
          anyFailed = true;
        }
      }

      if (anyFailed) {
        this.logger.warn(
          "[updateDOM] one or more targeted DOM ops failed; rebuilding tempWrapper from treeState for a full morphdom sync"
        );
        // Strip success markers — we're going to do a full diff now.
        for (const c of successContainers) {
          c.removeAttribute(TARGETED_APPLIED_ATTR);
        }
        // Re-render full HTML (no skip placeholders) and reset tempWrapper.
        const fullHtml = this.treeRenderer.renderState();
        tempWrapper.innerHTML = fullHtml;
      } else {
        this.replaceTargetedSkipPlaceholders(tempWrapper);
      }
    }

    try {
      // Use morphdom to efficiently update the element
      morphdom(element, tempWrapper, morphdomOptions);
    } finally {
      // Strip lifecycle markers regardless of whether morphdom threw,
      // preventing leaked attributes on the live DOM.
      this.rangeDomApplier.cleanupMarkers(element);
    }

    // Restore focus to previously focused element
    this.focusManager.restoreFocusedElement();

    // Two classes of post-render scans:
    //
    //   FIRE-ON-CHANGE (always run): handleScrollDirectives,
    //   handleHighlightDirectives, handleAnimateDirectives,
    //   handleToastDirectives, setupScrollAway. These detect VALUE changes
    //   on existing directive-bearing elements (e.g. lvt-fx:highlight
    //   flashes on every render where the underlying value changed) — so
    //   they must run on every render. Cost is bounded: each does a CSS
    //   attribute selector qsa for its specific directive (`[lvt-fx\:highlight]`
    //   etc.); for a 10k-row LargeTable where rows DON'T have these
    //   directives, the qsa returns empty in ~1-3ms total.
    //
    //   WIRE-IDEMPOTENT (skip when nothing new): setupFxDOMEventTriggers,
    //   setupDOMEventTriggerDelegation, uploadHandler.initializeFileInputs.
    //   These walk EVERY descendant via qsa("*") to attach event listeners
    //   on lvt-fx:event:on:trigger / lvt-el: / file inputs. They have
    //   per-element guards so re-running is safe but wasteful — at 80k
    //   descendants the walk costs ~150-200ms each. Skip when neither
    //   morphdom.onNodeAdded fired nor a new lvt-* directive attribute
    //   appeared on any morphed element (tracked via onBeforeElUpdated).
    handleScrollDirectives(element);
    handleHighlightDirectives(element);
    handleAnimateDirectives(element);
    handleToastDirectives(element);
    setupScrollAway(element);
    if (this.nodesAddedThisRender > 0 || this.directiveTouchedThisRender) {
      setupFxDOMEventTriggers(element, this.wrapperElement || undefined);
      this.eventDelegator.setupDOMEventTriggerDelegation(element);
      this.uploadHandler.initializeFileInputs(element);
    }

    // changeAutoWirer always runs: its eviction loop must process
    // wirings on removed elements too, regardless of additions.
    this.changeAutoWirer.wireElements();

    if (meta) {
      this.formLifecycleManager.handleResponse(meta);
    }
  }

  /**
   * Handle upload_start response from server
   */
  private handleUploadStartResponse(response: UploadStartResponse): void {
    this.uploadHandler.handleUploadStartResponse(response);
  }

  /**
   * Walk tempWrapper for `<!--lvt-targeted-skip:path-->` comments left by
   * `reconstructFromTree` and convert each into a `data-lvt-targeted-skip`
   * attribute on its parent element. The marker tells morphdom (via its
   * onBeforeElUpdated callback) to short-circuit the subtree, leaving the
   * live container's existing children — already updated by the applier —
   * untouched.
   */
  private replaceTargetedSkipPlaceholders(tempWrapper: Element): void {
    const walker = document.createTreeWalker(
      tempWrapper,
      NodeFilter.SHOW_COMMENT
    );
    const toReplace: Comment[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const c = node as Comment;
      if (c.nodeValue && /^lvt-targeted-skip:.+$/.test(c.nodeValue)) {
        toReplace.push(c);
      }
    }
    for (const c of toReplace) {
      const match = c.nodeValue!.match(/^lvt-targeted-skip:(.+)$/);
      const path = match ? match[1] : "";
      const parent = c.parentElement;
      if (parent) {
        parent.setAttribute(TARGETED_SKIP_ATTR, path);
      }
      c.remove();
    }
  }

  /**
   * Execute lifecycle hook on an element
   * @param element - Element with lifecycle hook attribute
   * @param hookName - Name of the lifecycle hook attribute (e.g., 'lvt-mounted')
   */
  private executeLifecycleHook(element: Element, hookName: string): void {
    const hookValue = element.getAttribute(hookName);
    if (!hookValue) {
      return;
    }

    try {
      // Create a function from the hook value and execute it
      // The function has access to 'this' (the element) and 'event'
      const hookFunction = new Function("element", hookValue);
      hookFunction.call(element, element);
    } catch (error) {
      this.logger.error(`Error executing ${hookName} hook:`, error);
    }
  }

  /**
   * Reset client state (useful for testing).
   *
   * Puts the client back into its pre-initialization state: tree state,
   * focus state, observers, change auto-wirer, form lifecycle, loading
   * indicator, form disabler, lvtId, AND isInitialized are all cleared.
   *
   * Behavioral note: `isInitialized` is set to false here. Prior to the
   * introduction of `resetSessionState()`, `reset()` left this flag sticky,
   * which was an inconsistency — a "reset" that didn't actually put the
   * client in a pre-init state. After calling reset(), the next payload
   * is treated as an initial render: the loading indicator will briefly
   * appear, forms are re-enabled, and `data-lvt-loading` is cleared. If
   * callers of reset() expected the prior sticky behavior, they should
   * not rely on init-only side effects firing exactly once per client
   * lifetime.
   */
  reset(): void {
    this.resetSessionState();
  }

  /**
   * Get current tree state (for debugging)
   */
  getTreeState(): TreeNode {
    return this.treeRenderer.getTreeState();
  }

  /**
   * Get the static structure if available
   */
  getStaticStructure(): string[] | null {
    return this.treeRenderer.getStaticStructure();
  }
}

// Auto-initialize when script loads (for browser use)
if (typeof window !== "undefined") {
  LiveTemplateClient.autoInit();
}
