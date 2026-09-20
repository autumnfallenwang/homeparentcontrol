import { z } from "zod";

/**
 * Shared scalar shapes. Nothing here is a database row (R9) — these describe
 * bytes on the wire, and the persistence layer is free to disagree.
 */

/**
 * `event_id` — the idempotency key, and the only thing standing between
 * at-least-once delivery and double-counted reports (§4.4 / X5).
 *
 * ⚠️ Pinned to this literal regex rather than `z.uuid({ version: "v7" })`.
 * Zod's helper is case-INSENSITIVE (`[0-9a-fA-F]`, `[89abAB]`), and the spec
 * requires canonical *lowercase* hyphenated UUIDv7 and says the server
 * **rejects rather than normalises** — one spelling, loud in dev. A
 * non-conforming value becomes `rejected_events[] { retryable: false }`.
 */
export const EVENT_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const eventId = z
  .string()
  .regex(EVENT_ID_REGEX, "event_id must be a canonical lowercase hyphenated UUIDv7");

/** Identifiers are bare UUIDs on the wire — no prefixes (§4.1). */
export const uuid = z.uuid();

/** RFC 3339 instant with an offset. Always UTC in practice. */
export const instant = z.iso.datetime({ offset: true });

/** Wall-clock time of day, `HH:MM`. Never an instant — see §4.3's midnight-wrap note. */
export const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM");

/** Calendar date, `YYYY-MM-DD`. */
export const calendarDate = z.iso.date();

/** IANA timezone name. Not validated against tzdata — the agent owns that. */
export const timezone = z.string().min(1);

export const weekday = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

/**
 * R5 — unknown enum values degrade, they do not crash.
 *
 * Returns a *pair*: `tolerant` for parsing (falls back instead of throwing),
 * and `strict` purely so a caller can detect that degradation happened and
 * name the offending field in a `policy_degraded` event, which R5 requires
 * ("the parent is told which field and which agent version").
 */
export function degradingEnum<const T extends readonly [string, ...string[]]>(
  values: T,
  fallback: T[number],
) {
  const strict = z.enum(values);
  return { strict, tolerant: strict.catch(fallback as never) };
}
