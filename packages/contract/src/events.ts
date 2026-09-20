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
 * ⚠️ The element shape of `rejected_events[]` is never specified — only
 * `{ retryable: false }` is stated, and `bad_event_id_format` is named as a
 * counter rather than a field. Modelled loosely so a server can add a reason
 * without breaking agents, and so we are not inventing a wire field that R2
 * would then forbid us from renaming.
 */
export const rejectedEvent = z.looseObject({
  retryable: z.boolean(),
});

export const eventsResponse = z.object({
  contract: z.int().default(CONTRACT_MINOR),
  accepted_event_ids: z.array(eventId).default([]),
  rejected_events: z.array(rejectedEvent).default([]),
  next_batch_allowed_in_ms: z.int().nonnegative().default(0),
});
export type EventsResponse = z.infer<typeof eventsResponse>;
