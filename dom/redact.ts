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
 *   2. Incoming (hydrateRedactedTokens): after each DOM patch, real values are
 *      filled back into `[data-lvt-redact]` elements from localStorage — `.value`
 *      for inputs, `textContent` for the <span> the Go `lvt.Redact` helper emits.
 *      Substitution is scoped to the attribute, never a free text scan, so
 *      user-posted content cannot trigger it.
 *
 * Values are namespaced by the page's `data-lvt-id` scope so two LiveTemplate
 * pages in the same origin don't collide.
 */

const STORAGE_PREFIX = "lvt-redact";

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
 * Collect every redact-tagged element at or under `root` — `root` itself when it
 * carries the attribute, plus all descendants. Used by both the outgoing path
 * (the action element may be the tagged input) and the incoming path (so a
 * tagged root is hydrated, not just its children).
 */
function collectRedactElements(root: Element): Element[] {
  const found: Element[] = [];
  if (root.hasAttribute("data-lvt-redact")) {
    found.push(root);
  }
  root.querySelectorAll?.("[data-lvt-redact]").forEach((el) => found.push(el));
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

  for (const el of collectRedactElements(actionElement)) {
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
 * Fill every `[data-lvt-redact]` element from localStorage. Call on the LIVE
 * element after the patch commits. Substitution is scoped to elements carrying
 * the attribute — never a free text scan — so user-posted content can't trigger
 * it. Value elements (input/textarea/select) get `.value`; others (the <span>
 * the Go lvt.Redact helper emits) get `textContent`. Reads are cached per call.
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

  // Skip the element the user is currently editing — overwriting .value
  // mid-keystroke would clobber in-progress input (and the stored value may lag
  // what they've typed since the last dispatch).
  const active = root.ownerDocument?.activeElement ?? null;
  for (const el of collectRedactElements(root)) {
    if (el === active) continue;
    const field = el.getAttribute("data-lvt-redact");
    if (!field) continue;
    const v = read(field);
    if (v === null) continue;
    if (hasValue(el)) {
      // For file inputs, el.value is the fake C:\fakepath string, not file
      // contents — redacting file fields is out of scope for this helper.
      el.value = v;
    } else {
      el.textContent = v;
    }
  }
}
