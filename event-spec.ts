/**
 * The LiveTemplate client lifecycle event contract.
 *
 * These events already existed, dispatched from four different modules with no
 * single place describing them. This file is that place: it is the stable
 * contract a custom attribute handler programs against, and it is DESCRIPTIVE —
 * every name and payload below is what the client dispatches today, not a
 * proposal.
 *
 * Handlers observe these through the DOM, so there is no second interface to
 * implement. `AttributeHandler` (see `attribute-registry.ts`) stays the only
 * type an author implements; this one is here to be read, and to give the
 * payloads names that survive a refactor.
 *
 * WHERE EACH EVENT IS DISPATCHED MATTERS. They do not all fire on the same
 * node, and none of them bubble by default — a handler that listens on the
 * wrapper will not see a form event, and vice versa. The `target` column below
 * is part of the contract, not an implementation detail.
 */

import type { ResponseMetadata } from "./types";

/**
 * Action lifecycle, dispatched on the ACTIVE FORM by FormLifecycleManager.
 *
 *   lvt:done     — every response for a form action, success or failure, first.
 *   lvt:success  — meta.success === true.
 *   lvt:error    — meta.success === false; meta.errors carries the field errors.
 */
export type FormLifecycleEventName = "lvt:done" | "lvt:success" | "lvt:error";

export type FormLifecycleEvent = CustomEvent<ResponseMetadata>;

/**
 * Dispatched on the ELEMENT THAT TRIGGERED an action, by the event delegator,
 * at the moment the action is sent. `detail` is the outgoing action message.
 */
export type PendingEvent = CustomEvent<{ action: string; data?: unknown }>;

/** Dispatched on the WRAPPER after every applied tree update. */
export type UpdatedEvent = CustomEvent<{
  messageCount: number;
  action?: string;
  success?: boolean;
}>;

/**
 * Dispatched on the WRAPPER for a topic-level error envelope.
 *
 * Note the name collision, which is load-bearing to know about: `lvt:error` is
 * ALSO the form-lifecycle failure event, with a completely different payload
 * (`ResponseMetadata` vs `{code, topic}`) on a different target (the form vs
 * the wrapper). A listener bound to `document` in the capture phase sees both.
 * Documented rather than changed — renaming either one is a wire-visible
 * behaviour change and belongs to its own release, not to a refactor.
 */
export type TopicErrorEvent = CustomEvent<{ code: string; topic?: string }>;

/** Transport state, dispatched on the WRAPPER as plain (detail-less) Events. */
export type ConnectionEventName = "lvt:connected" | "lvt:disconnected" | "lvt:reconnected";

/** Upload progress, dispatched on the WRAPPER. */
export type UploadEventName = "lvt:upload:progress" | "lvt:upload:complete" | "lvt:upload:error";

/**
 * Every lifecycle event name the client dispatches, for a handler that wants to
 * subscribe defensively (or a test that wants to assert the surface hasn't
 * grown silently).
 */
export const LIFECYCLE_EVENTS = [
  "lvt:pending",
  "lvt:done",
  "lvt:success",
  "lvt:error",
  "lvt:updated",
  "lvt:connected",
  "lvt:disconnected",
  "lvt:reconnected",
  "lvt:upload:progress",
  "lvt:upload:complete",
  "lvt:upload:error",
] as const;

export type LifecycleEventName = (typeof LIFECYCLE_EVENTS)[number];
