import { z } from "zod";
import { eventId, instant, uuid } from "./primitives.js";
import { CONTRACT_MINOR } from "./version.js";

/**
 * `POST /api/agent/v1/events` — telemetry (§4.4).
 *
 * R8: store first, interpret later. The transport knows the envelope and
 * NOTHING about `data`. An unknown `type` is stored verbatim and counted, never
 * rejected — that is what makes D.1 and D.2 safe to defer: adding per-app
 * reporting later is a backfill, not a migration.
 */

/** Drives flush timing and retention: `sample` 90 d, `audit` 400 d. Audit flushes immediately. */
export const eventClass = z.enum(["sample", "audit"]);

export const eventEnvelope = z.object({
  event_id: eventId,
  /** Free-form by design (R8). Never enumerate. */
  type: z.string().min(1),
  /** Per-`type`, NOT the contract version. */
  v: z.int().default(1),
  class: eventClass,
  /** Advisory only — the server records `received_at` as authoritative. */
  ts: instant,
  /** Ordering is clock-independent: `(boot_id, seq)`. */
  seq: z.int().nonnegative(),
  /**
   * The boot this event was RECORDED in, when it differs from the batch's.
   *
   * ⚠️ Not in the design document, and additive (R2). `boot_id` is specified
   * only at batch level, but the agent's queue is durable across reboots — so
   * draining a backlog after a reboot would stamp pre-reboot events with the
   * current boot and silently corrupt `(boot_id, seq)`, which is the only
   * clock-independent ordering key there is. Absent means "the batch's".
   */
  boot_id: uuid.optional(),
  /** Opaque. The transport must never know what is in here. */
  data: z.record(z.string(), z.unknown()).optional(),
});
export type EventEnvelope = z.infer<typeof eventEnvelope>;

export const eventsRequest = z.object({
  contract: z.int().default(CONTRACT_MINOR),
  /** On the batch, not the event. */
  device_id: uuid,
  boot_id: uuid,
  events: z.array(eventEnvelope),
});
export type EventsRequest = z.infer<typeof eventsRequest>;

/**
 * One event the server refused. The batch still succeeds — §5.7: "validate per
 * event, not per batch, so *I took 1,998 of your 2,000* is expressible."
 *
 * ⚠️ The element shape is never specified; only `{ retryable: false }` is
 * stated, and `bad_event_id_format` is named as a counter rather than a field.
 * Defined here in phase 2 from what the handler actually needs.
 *
 * ⚠️ `event_id` is a plain string, NOT the strict UUIDv7 type. The commonest
 * rejection is a malformed id (X5 — the server rejects rather than
 * normalises), and the agent still has to know which queued event to drop.
 *
 * ⚠️ `retryable` is always `false` today. A per-event rejection means
 * *permanently unacceptable*; anything transient is a whole-request failure,
 * which maps to `backoff` and leaves the batch queued. Keeping the field means
 * a future transient case needs no wire change; emitting `true` would need
 * agent-side rules the design document does not contain.
 */
export const rejectedEvent = z.looseObject({
  /** As submitted — possibly not a valid UUID, which is often why it was rejected. */
  event_id: z.string(),
  /** `bad_event_id_format` | `bad_event_class` | `schema` — an open list. */
  reason: z.string(),
  retryable: z.boolean(),
});

export const eventsResponse = z.object({
  contract: z.int().default(CONTRACT_MINOR),
  accepted_event_ids: z.array(eventId).default([]),
  rejected_events: z.array(rejectedEvent).default([]),
  next_batch_allowed_in_ms: z.int().nonnegative().default(0),
});
export type EventsResponse = z.infer<typeof eventsResponse>;
