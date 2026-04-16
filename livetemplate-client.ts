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
import { TreeRenderer } from "./state/tree-renderer";
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
        canSendNavigate: () => !this.useHTTP,
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

    // Set up lifecycle listeners for lvt-fx:*:on:{lifecycle} attributes
    setupFxLifecycleListeners(this.wrapperElement);

    // Initialize focus tracking
    this.focusManager.attach(this.wrapperElement);

    // Set up infinite scroll observers
    this.observerManager.setupInfiniteScrollObserver();
    this.observerManager.setupInfiniteScrollMutationObserver();
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect(): void {
    this.webSocketManager.disconnect();
    this.ws = null;
    this.useHTTP = false;
    this.eventDelegator.teardownDOMEventTriggerDelegation();
    if (this.wrapperElement) {
      teardownFxDOMEventTriggers(this.wrapperElement);
      teardownFxLifecycleListeners(this.wrapperElement);
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
    this.focusManager.reset();
    this.observerManager.teardown();
    this.changeAutoWirer.teardown();
    this.formLifecycleManager.reset();
    this.loadingIndicator.hide();
    this.formDisabler.enable(this.wrapperElement);
    this.lvtId = null;
    this.isInitialized = false;
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
  private sendNavigate(href: string): void {
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

    // Keep liveUrl in sync so that any subsequent WebSocket reconnect uses
    // the new URL's query params rather than the initial-connect URL. This
    // matters if the socket is mid-reconnect when sendNavigate is called —
    // the message would not be sent, but the reconnect that follows will
    // use the updated liveUrl and arrive at the correct state.
    const newLiveUrl = url.pathname + url.search;
    this.liveUrlOverride = newLiveUrl;
    this.webSocketManager.setLiveUrl(newLiveUrl);

    // __navigate__ is a WebSocket-only in-band action — only call send()
    // when the socket is actually OPEN.
    //
    // Note: this.useHTTP is not checked here because sendNavigate() is only
    // reachable when canSendNavigate() returns true (i.e. !this.useHTTP),
    // enforced by LinkInterceptor. Checking useHTTP here would be dead code.
    //
    // liveUrl was updated above, so a pending or future reconnect will land
    // on the correct URL. If autoReconnect is disabled and the socket is
    // CLOSED (readyState 3), the navigate is lost until the user reloads —
    // emit an error so this is visible in logs.
    if (this.webSocketManager.getReadyState() !== 1 /* WebSocket.OPEN */) {
      const readyState = this.webSocketManager.getReadyState();
      if (readyState === 3 /* CLOSED */) {
        this.logger.error(
          "sendNavigate: WebSocket is CLOSED and autoReconnect may be disabled; " +
          "navigate message dropped. Reload or re-enable autoReconnect.",
          { href }
        );
      } else {
        // WS is CONNECTING (0) or CLOSING (2). liveUrl was updated above, so
        // the next reconnect will use the new URL. However, for CONNECTING:
        // if the in-progress handshake succeeds and the server lands on the
        // OLD URL before reconnect fires, the navigate is silently lost until
        // the socket later drops and reconnects. This is an edge case only when
        // autoReconnect is enabled and the CONNECTING handshake completes at
        // the old URL before being superseded. With autoReconnect enabled, the
        // next drop+reconnect recovers correctly; with autoReconnect off, there
        // may be no recovery until the user reloads.
        this.logger.warn(
          "sendNavigate: WS not open; browser URL is ahead of server state until reconnect",
          { href, readyState }
        );
      }
      return;
    }

    this.logger.debug("sendNavigate", { href, data });
    this.send({ action: "__navigate__", data });
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
    // Apply update to internal state and get reconstructed HTML
    const result = this.applyUpdate(update);

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

    // Use morphdom to efficiently update the element
    morphdom(element, tempWrapper, {
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
      onBeforeElUpdated: (fromEl, toEl) => {
        // Honour lvt-preserve: the client owns this element's entire
        // subtree and morphdom should never touch any of it.
        // Attributes, content, descendants all stay exactly as the DOM
        // currently has them. Equivalent to Phoenix LiveView's
        // phx-update="ignore" and Turbo's data-turbo-permanent. Useful
        // for third-party widgets (maps, date pickers, charts) that
        // mutate their own DOM, and for scroll containers with
        // JS-managed scrollTop.
        //
        // We check toEl (the incoming server version) rather than fromEl
        // (the current DOM). This gives the server authority: if a later
        // render omits lvt-preserve, morphdom resumes updating the element.
        // Checking fromEl would make the attribute sticky in the DOM
        // forever once applied, preventing the server from ever removing it.
        //
        // For the subtler case of "preserve my *attributes* but still
        // let children update" (e.g. <details open>, <select> with
        // user-selected options), use lvt-preserve-attrs below.
        if (
          toEl.nodeType === Node.ELEMENT_NODE &&
          (toEl as Element).hasAttribute("lvt-preserve")
        ) {
          return false;
        }

        // Honour lvt-preserve-attrs: the client owns this element's own
        // attributes (e.g. the <details open> state the user toggled),
        // but its children should still be diffed against the new tree.
        // This is the right fit for collapsible pickers where the
        // *container* state is user-managed but the *items* inside are
        // server-authored and must reflect the latest data.
        //
        // Implementation: copy fromEl's attributes that are missing from
        // toEl onto toEl before morphdom runs its attribute diff. This
        // makes morphdom see the user-owned attrs as "already present"
        // in the new version, so it doesn't remove them. Attributes that
        // exist in both fromEl and toEl take toEl's value (server wins
        // over client for attributes the template does control), which
        // preserves the ability to update className etc. on the same
        // element from the server.
        //
        // Limitation: only *missing* attributes from fromEl are copied.
        // If the server's toEl already has e.g. class="card", that value
        // is used — JS-added classes (el.classList.add('open')) are
        // silently overwritten on the next diff. Use lvt-preserve-attrs
        // for attributes the server template does NOT set at all.
        //
        // We check toEl (the incoming server tree), not fromEl (the live
        // DOM), so the server has authority: removing lvt-preserve-attrs
        // from the template takes effect immediately on the next render,
        // consistent with how lvt-preserve works.
        if (
          toEl.nodeType === Node.ELEMENT_NODE &&
          (toEl as Element).hasAttribute("lvt-preserve-attrs") &&
          fromEl.nodeType === Node.ELEMENT_NODE
        ) {
          const fromAttrs = (fromEl as Element).attributes;
          const toElement = toEl as Element;
          for (let i = 0; i < fromAttrs.length; i++) {
            const attr = fromAttrs[i];
            // Skip the preserve control attributes themselves so the
            // server can opt elements in/out across renders. If we
            // copied lvt-preserve-attrs back onto toEl, the server
            // could never remove the attribute in a future update.
            if (
              attr.name === "lvt-preserve" ||
              attr.name === "lvt-preserve-attrs"
            ) {
              continue;
            }
            // Use hasAttributeNS / setAttributeNS to preserve namespace
            // info (e.g. xlink:href on SVG elements). For plain HTML
            // attributes namespaceURI is null, so this degrades to the
            // same behaviour as setAttribute.
            if (!toElement.hasAttributeNS(attr.namespaceURI, attr.localName)) {
              toElement.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
            }
          }
          // Fall through to normal diff path so children are still updated.
        }

        // Skip update entirely for focused form elements to preserve user
        // input. This also skips attribute updates (class, disabled, aria-*)
        // and the lvt-updated hook — use data-lvt-force-update to override.
        if (this.focusManager.shouldSkipUpdate(fromEl)) {
          return false;
        }

        // Only update if content actually changed
        if (fromEl.isEqualNode(toEl)) {
          return false;
        }
        // Execute lvt-updated lifecycle hook
        this.executeLifecycleHook(fromEl, "lvt-updated");
        return true;
      },
      onElUpdated: (el) => {
        // Textarea-specific: morphdom patches child text nodes but browsers
        // ignore textContent changes to "dirty" textareas (ones the user
        // has typed in), so we explicitly set .value. Inputs don't need
        // this — morphdom sets .value directly for input elements.
        if (el instanceof HTMLTextAreaElement) {
          el.value = el.textContent ?? "";
        }
      },
      onNodeAdded: (node) => {
        // Sync textarea value for newly inserted textarea elements
        if (node instanceof HTMLTextAreaElement) {
          node.value = node.textContent ?? "";
        }
        // Execute lvt-mounted lifecycle hook
        if (node.nodeType === Node.ELEMENT_NODE) {
          this.executeLifecycleHook(node as Element, "lvt-mounted");
        }
      },
      onBeforeNodeDiscarded: (node) => {
        // Execute lvt-destroyed lifecycle hook
        if (node.nodeType === Node.ELEMENT_NODE) {
          this.executeLifecycleHook(node as Element, "lvt-destroyed");
        }
        return true;
      },
    });

    // Restore focus to previously focused element
    this.focusManager.restoreFocusedElement();

    // Handle scroll directives (implicit trigger only)
    handleScrollDirectives(element);

    // Handle highlight directives (implicit trigger only)
    handleHighlightDirectives(element);

    // Handle animate directives (implicit trigger only)
    handleAnimateDirectives(element);

    // Set up DOM event triggers for lvt-fx: attributes with :on:{event}
    // Registry always lives on wrapperElement so teardown can find all entries
    setupFxDOMEventTriggers(element, this.wrapperElement || undefined);

    // Re-scan updated subtree for lvt-el:*:on:{event} DOM triggers
    this.eventDelegator.setupDOMEventTriggerDelegation(element);

    // Handle toast trigger directives (ephemeral client-side toasts)
    handleToastDirectives(element);

    // Initialize upload file inputs
    this.uploadHandler.initializeFileInputs(element);

    // Auto-wire change listeners for bound form fields
    this.changeAutoWirer.wireElements();

    // Handle form lifecycle if metadata is present
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
