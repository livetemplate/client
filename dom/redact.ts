/**
 * Preview-mode field redaction.
 *
 * Some apps (e.g. a "try it before you sign up" preview) need sensitive field
 * values — passport numbers, tax IDs, draft answers — to stay in the visitor's
 * browser and never reach the server. An element opts in with the
 * `data-lvt-redact="<field>"` attribute:
 *
 *   <input name="passport" data-lvt-redact="passport">
 *
 * Two halves make the round-trip work:
 *
 *   1. Outgoing: before an action payload is sent, the raw value is written to
 *      localStorage and replaced with a redact sentinel `{ redacted: true, field }`.
 *      The server learns the field was provided (so it can keep structural state /
 *      validate presence) but never sees the value. Two sinks cover the two send
 *      transports: `redactActionData` for the JSON payload (WebSocket / HTTP-JSON)
 *      and `redactFormData` for the multipart file-upload path.
 *
 *   2. Incoming (hydrateRedactedTokens): before each DOM patch is applied, real
 *      values are substituted back in from localStorage — both into
 *      `input[data-lvt-redact]` element values and into `[[field]]` placeholder
 *      tokens in text content (the token the Go `lvt.Redact` helper emits).
 *
 * Values are namespaced by the page's `data-lvt-id` scope so two LiveTemplate
 * pages in the same origin don't collide.
 */

const STORAGE_PREFIX = "lvt-redact";

// Matches the placeholder token emitted by the Go `lvt.Redact(name)` helper.
// Field names are word chars plus dot/hyphen (e.g. "tax_id", "address.line1").
// The grammar is bracket-based, not angle-based: "<<name>>" is mangled by both
// html/template's escaper and the browser's innerHTML parser (it reads "<name>"
// as a tag), whereas "[[name]]" survives every context intact.
//
// The `g` flag carries `lastIndex` state, but it is only ever used with
// String.prototype.replace (which resets lastIndex on each call), so the shared
// module-level instance is safe. Do not switch to `.exec()` in a loop without
// reconsidering this.
const TOKEN_RE = /\[\[([\w.-]+)\]\]/g;

export interface RedactOptions {
  /** Storage backend; defaults to window.localStorage. Injectable for tests. */
  storage?: Storage;
  /** Namespace for stored values; defaults to the page's data-lvt-id. */
  scope?: string;
}

/** The sentinel that replaces a redacted value in an outgoing action payload. */
export interface RedactSentinel {
  redacted: true;
  field: string;
}

function storageKey(scope: string, field: string): string {
  return `${STORAGE_PREFIX}:${scope}:${field}`;
}

/**
 * Resolve the redaction namespace from the live DOM. Uses the wrapper's
 * `data-lvt-id` so values are scoped per page. Falls back to "lvt-unknown"
 * before the wrapper is wired (no value collides with a real scope).
 */
function resolveScope(ownerDocument: Document | null | undefined): string {
  const doc = ownerDocument ?? (typeof document !== "undefined" ? document : null);
  const wrapper = doc?.querySelector?.("[data-lvt-id]");
  return wrapper?.getAttribute("data-lvt-id") || "lvt-unknown";
}

function getStorage(opts?: RedactOptions): Storage | null {
  if (opts?.storage) return opts.storage;
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    // localStorage can throw (disabled cookies, sandboxed iframe). Treat as
    // absent — redaction degrades to a no-op rather than breaking the app.
    return null;
  }
}

/** Elements that carry a redactable value: <input>, <textarea>, <select>. */
function hasValue(el: Element): el is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  );
}

/**
 * Collect every redact-tagged value element at or under `actionElement`.
 * `actionElement` itself is included when it is the tagged element (the
 * single-input change/input event path), as well as any descendants (the
 * form-submit path).
 */
function collectRedactInputs(actionElement: Element): Element[] {
  const found: Element[] = [];
  if (actionElement.hasAttribute("data-lvt-redact")) {
    found.push(actionElement);
  }
  actionElement
    .querySelectorAll?.("[data-lvt-redact]")
    .forEach((el) => found.push(el));
  return found;
}

/**
 * Shared outgoing-redaction core. For every redact-tagged element at/under
 * `actionElement`: persist its value to localStorage and hand the sink the
 * payload key + sentinel to write. The sink differs per transport (a JSON
 * payload object vs. a multipart FormData).
 *
 * Redaction is fail-closed: the sentinel is ALWAYS written, regardless of
 * whether persistence is possible. Persistence is the best-effort part — if
 * localStorage is entirely unavailable (disabled / sandboxed iframe) or setItem
 * throws (quota), the raw value is still dropped from the payload so it never
 * reaches the server. The security guarantee (never leak) takes priority over
 * the UX (being able to restore the value later).
 */
function applyOutgoingRedaction(
  actionElement: Element,
  opts: RedactOptions | undefined,
  sink: (key: string, sentinel: RedactSentinel) => void,
): void {
  const storage = getStorage(opts);
  const scope = storage
    ? (opts?.scope ?? resolveScope(actionElement.ownerDocument))
    : null;

  for (const el of collectRedactInputs(actionElement)) {
    const field = el.getAttribute("data-lvt-redact");
    if (!field || !hasValue(el)) continue;

    // Persist best-effort; both branches (no storage, setItem throws) fall
    // through to the sentinel write below — never to leaking the raw value.
    if (storage && scope) {
      try {
        storage.setItem(storageKey(scope, field), el.value);
      } catch {
        // Quota exceeded — value not persisted, but still redacted below.
      }
    }
    // The payload key the server sees is the element's `name` (falling back to
    // the redact field name, mirroring the event-delegation "name || value"
    // convention).
    const key = el.getAttribute("name") || field;
    sink(key, { redacted: true, field });
  }
}

/**
 * Persist redacted values to localStorage and replace them in the outgoing
 * JSON action payload with a sentinel. Mutates `data` in place. Used by the
 * WebSocket / HTTP-JSON send path.
 */
export function redactActionData(
  actionElement: Element,
  data: Record<string, unknown>,
  opts?: RedactOptions,
): void {
  applyOutgoingRedaction(actionElement, opts, (key, sentinel) => {
    data[key] = sentinel;
  });
}

/**
 * Persist redacted values to localStorage and replace them in an outgoing
 * multipart `FormData` with a JSON-encoded sentinel. Mutates `formData` in
 * place. Used by the Tier-1 file-upload send path (sendHTTPMultipart), which
 * bypasses the JSON payload — without this, a redacted field in a form that
 * also has a file input would POST its raw value as a multipart field.
 *
 * FormData values are strings, so the sentinel is JSON-encoded; the server
 * recognises a redacted multipart field by parsing the value and finding
 * `redacted:true` (mirroring the object sentinel on the JSON path).
 */
export function redactFormData(
  form: Element,
  formData: FormData,
  opts?: RedactOptions,
): void {
  applyOutgoingRedaction(form, opts, (key, sentinel) => {
    formData.set(key, JSON.stringify(sentinel));
  });
}

/**
 * Substitute real values back into the rendered DOM. Call on the LIVE element
 * after the patch commits (redacted content tokens are static, so they only
 * exist on the committed DOM, never in an update patch).
 *
 * Handles two surfaces:
 *   - `input[data-lvt-redact]` (and textarea/select): sets `.value`.
 *   - `[[field]]` tokens in text nodes: replaces with the stored value.
 *
 * Reads are cached per call so repeated tokens cost one storage hit each.
 */
export function hydrateRedactedTokens(root: Element, opts?: RedactOptions): void {
  const storage = getStorage(opts);
  if (!storage) return;
  const scope = opts?.scope ?? resolveScope(root.ownerDocument);

  const cache = new Map<string, string | null>();
  const read = (field: string): string | null => {
    if (cache.has(field)) return cache.get(field)!;
    let v: string | null = null;
    try {
      v = storage.getItem(storageKey(scope, field));
    } catch {
      v = null;
    }
    cache.set(field, v);
    return v;
  };

  // 1. Tagged value elements. Skip the element the user is currently editing —
  // overwriting .value mid-keystroke would clobber in-progress input (and the
  // stored value may lag what they've typed since the last dispatch).
  const active = root.ownerDocument?.activeElement ?? null;
  root.querySelectorAll?.("[data-lvt-redact]").forEach((el) => {
    if (el === active) return;
    const field = el.getAttribute("data-lvt-redact");
    if (!field || !hasValue(el)) return;
    const v = read(field);
    if (v !== null) el.value = v;
  });

  // 2. `[[field]]` tokens in text nodes. Walk only text nodes; never touches
  // attributes or element structure, so morphdom still diffs normally.
  const ownerDoc = root.ownerDocument;
  if (!ownerDoc) return;
  const walker = ownerDoc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const pending: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeValue && n.nodeValue.includes("[[")) {
      pending.push(n as Text);
    }
  }
  for (const textNode of pending) {
    const replaced = textNode.nodeValue!.replace(TOKEN_RE, (whole, field: string) => {
      const v = read(field);
      return v !== null ? v : whole;
    });
    if (replaced !== textNode.nodeValue) {
      textNode.nodeValue = replaced;
    }
  }
}
