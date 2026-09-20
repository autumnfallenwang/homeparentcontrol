import {
  CONTRACT_MINOR,
  type EventEnvelope,
  type EventsResponse,
  eventEnvelope,
} from "@hpc/contract";
import type { Context } from "hono";
import { z } from "zod";
import { db } from "../db/index.js";
import { events } from "../db/schema.js";
import { log } from "../lib/logger.js";
import { ProblemError } from "../lib/problem.js";

/**
 * `POST /api/agent/v1/events` — telemetry (§4.4).
 *
 * ⚠️ **R8: store first, interpret later.** "The transport knows the envelope
 * and NOTHING about `data`. Unknown `type` is stored verbatim in JSONB and
 * increments `unknown_event_type` — never rejected." That is what makes D.1
 * and D.2 safe to defer: adding per-app reporting later is a *backfill*, not a
 * migration, because the data is already sitting in JSONB waiting for a
 * projection nobody has written yet.
 *
 * Almost all of this handler's design is about what it must NOT do:
 *   · must not reject an unknown `type` (R8)
 *   · must not normalise an `event_id` (X5 — reject, never normalise)
 *   · must not interpret `data`
 *   · must not fail a batch because one event is bad (§5.7)
 *   · must not touch `last_sync_at` or anything the liveness job reads (A.26)
 */

/** §4.4 — the agent's own stated cap. Over this is what `halve_batch` is for. */
const MAX_BATCH_EVENTS = 2_000;

/**
 * Types this server currently knows how to project.
 *
 * ⚠️ This list does NOT gate ingest — R8 forbids that, and an unknown type is
 * stored verbatim exactly like any other. It exists so `unknown_event_type`
 * means something: the spec names the counter but never says what "unknown"
 * is measured against. Mirrors `telemetry.collect`'s default globs, so the
 * count answers "is the agent sending us something we have no projection for
 * yet" — which is the question that makes a backfill discoverable.
 */
const KNOWN_EVENT_PREFIXES = [
  "session.",
  "enforcement.",
  "power.",
  "app.",
  "agent.",
  "policy.",
  "clock.",
  "queue.",
];

function isKnownType(type: string): boolean {
  return KNOWN_EVENT_PREFIXES.some((prefix) => type.startsWith(prefix));
}

/**
 * The batch envelope, WITHOUT the events.
 *
 * ⚠️ Deliberately not `eventsRequest`, which types `events` as an array of
 * parsed envelopes — one bad event would fail all 2,000, the exact opposite of
 * §5.7's "validate per event, not per batch, so *I took 1,998 of your 2,000*
 * is expressible". `eventsRequest` stays in the contract as the shape the
 * agent sends; the server is the tolerant reader.
 */
const batchHeader = z.object({
  contract: z.int().optional(),
  device_id: z.uuid(),
  boot_id: z.uuid(),
  events: z.array(z.unknown()),
});

export async function handleEvents(c: Context): Promise<Response> {
  const deviceId = c.get("deviceId") as string;
  const householdId = c.get("householdId") as string;

  const header = batchHeader.safeParse(await c.req.json().catch(() => null));
  if (!header.success) {
    // Not a readable batch at all → 400 / drop_batch. This is the ONLY
    // batch-level rejection; anything about an individual event comes back
    // inside a 202. 422 is never emitted.
    throw new ProblemError("malformed", header.error.issues[0]?.message);
  }
  const batch = header.data;

  // §5.9 — every agent handler re-checks that the credential's device matches
  // the body's. Scope is the actual security control, not the transport (X4).
  if (batch.device_id !== deviceId) {
    throw new ProblemError("scopeViolation", "device_id does not match the presented credential");
  }

  // §4.4 — 413 maps to `halve_batch`, which only makes sense against a size
  // limit. The spec never gives one; this is the agent's own batch cap.
  if (batch.events.length > MAX_BATCH_EVENTS) {
    throw new ProblemError(
      "payloadTooLarge",
      `batch of ${batch.events.length} exceeds ${MAX_BATCH_EVENTS} events`,
    );
  }

  const accepted: string[] = [];
  const rejected: EventsResponse["rejected_events"] = [];
  const rows: (typeof events.$inferInsert)[] = [];
  let unknownEventType = 0;
  let badEventIdFormat = 0;

  for (const raw of batch.events) {
    const parsed = eventEnvelope.safeParse(raw);
    if (!parsed.success) {
      const { id, reason } = classifyRejection(raw, parsed.error);
      if (reason === "bad_event_id_format") badEventIdFormat++;
      // ⚠️ Always `retryable: false`. A per-event rejection means permanently
      // unacceptable; anything transient fails the whole request instead,
      // which maps to `backoff` and leaves the batch queued. That invariant is
      // what stops a poison event wedging the drain forever.
      rejected.push({ event_id: id, reason, retryable: false });
      continue;
    }

    const event: EventEnvelope = parsed.data;
    // R8 — counted, never rejected. "Adding per-app reporting later is a
    // backfill, not a migration."
    if (!isKnownType(event.type)) unknownEventType++;
    accepted.push(event.event_id);
    rows.push({
      householdId,
      deviceId,
      eventId: event.event_id,
      type: event.type,
      v: event.v,
      class: event.class,
      // Advisory, and stored exactly as sent — no clamp, no sanity bound. An
      // implausible `ts` IS the evidence that a clock was stepped; the
      // reporting layer corrects against `received_at`, which the database
      // defaults so the server clock is authoritative.
      ts: new Date(event.ts),
      // Per-event boot wins over the batch's, so a post-reboot drain does not
      // mislabel everything it is catching up on.
      bootId: event.boot_id ?? batch.boot_id,
      seq: event.seq,
      data: event.data ?? {},
    });
  }

  let inserted = 0;
  if (rows.length > 0) {
    // ONE multi-row INSERT, never a loop: a 2,000-event drain must not become
    // 2,000 round trips.
    const returned = await db
      .insert(events)
      .values(rows)
      .onConflictDoNothing({ target: [events.deviceId, events.eventId] })
      .returning({ eventId: events.eventId });
    inserted = returned.length;
  }

  log.info(
    {
      event: "agent.events",
      device_id: deviceId,
      submitted: batch.events.length,
      accepted: accepted.length,
      inserted,
      duplicates: accepted.length - inserted,
      rejected: rejected.length,
      // The two "counters" §4.4 and X5 name. There is no Prometheus anywhere
      // in this cluster (C2), so they live on the log line Alloy already ships.
      unknown_event_type: unknownEventType,
      bad_event_id_format: badEventIdFormat,
    },
    "events ingested",
  );

  const response: EventsResponse = {
    contract: CONTRACT_MINOR,
    // ★ EVERY valid id submitted, NOT the ids `RETURNING` gave back.
    //
    // `ON CONFLICT DO NOTHING RETURNING` yields only newly-inserted rows, so
    // the naive implementation is the wrong one. §5.7: "a conflicting row is
    // still *accepted* — it is already durable. Returning only newly-inserted
    // rows would make the agent retry the same batch forever." That failure is
    // silent: the agent re-sends, the server accepts, nothing errors, and the
    // queue never drains.
    accepted_event_ids: accepted,
    rejected_events: rejected,
    // ⚠️ Always 0. The field appears once in the spec, as `0`, with no stated
    // semantics. The 600/min limiter already paces this endpoint; a second,
    // undocumented throttle is just a way to stall an agent by accident.
    next_batch_allowed_in_ms: 0,
  };
  return c.json(response, 202);
}

/**
 * Why one event was refused, and which one.
 *
 * `event_id` comes from the RAW value rather than the parsed one, because the
 * commonest rejection is that the id itself is malformed — and the agent still
 * has to know which queued event to drop.
 */
function classifyRejection(raw: unknown, error: z.ZodError): { id: string; reason: string } {
  const candidate = (raw as { event_id?: unknown } | null)?.event_id;
  const id = typeof candidate === "string" ? candidate : "";

  const paths = new Set(error.issues.map((issue) => String(issue.path[0] ?? "")));
  // X5 — "the server rejects rather than normalises. A normaliser that accepts
  // both spellings keeps the two-spelling hazard alive in the codebase."
  if (paths.has("event_id")) return { id, reason: "bad_event_id_format" };
  // Unlike `type`, an unknown `class` has no retention policy — sample is 90
  // days, audit is 400, and anything else creates rows the pruner will never
  // touch. Rejecting is the narrow exception to R8's never-reject.
  if (paths.has("class")) return { id, reason: "bad_event_class" };
  return { id, reason: "schema" };
}
