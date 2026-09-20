/**
 * Resolving a local wall-clock time in an IANA zone to a UTC instant.
 *
 * ⚠️ Used for exactly ONE thing: the `expires_at` of a synthesised override.
 * The policy document itself carries wall-clock strings plus the zone name and
 * never resolved instants — `timeOfDay` is "never an instant" in the contract,
 * and §3.2 forbids caching a resolved instant at all ("tzdata changes by
 * government decree"), which a signed document would be.
 *
 * ⚠️ THIS IS NOT THE AGENT'S BOUNDARY RESOLVER, and must not be mistaken for
 * it. §3.2 specifies that a boundary in a skipped hour snaps FORWARD to the
 * first instant that exists, and one in an ambiguous hour resolves toward
 * enforcement (later for `restricted_until`). This function does neither: at a
 * skipped hour it lands before the gap, and at an ambiguous hour it takes the
 * earlier occurrence.
 *
 * That is deliberate and safe HERE, because both behaviours make a relaxation
 * end *earlier* — the stricter direction, which is where §4.6 wants every
 * ambiguity to fall. It would be wrong for the agent, whose resolver is phase
 * 3's and has to implement the real rules. `zoned-time.test.ts` asserts these
 * two edges explicitly, so changing them shows up as a failing test rather
 * than a silent shift.
 *
 * No dependency: Node's Intl carries full tzdata.
 */

/** Milliseconds by which `tz` is ahead of UTC at the given instant. */
function offsetAt(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(new Date(utcMs))
    .reduce<Record<string, string>>((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});

  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    // Intl emits hour 24 for midnight under hour12:false in some ICU versions.
    parts.hour === "24" ? 0 : Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asIfUtc - utcMs;
}

/**
 * `("2026-12-25", "07:00", "America/New_York")` → the UTC instant.
 *
 * Two passes: the first guesses the offset from the naive timestamp, the
 * second re-reads it at the corrected instant. That converges everywhere
 * except inside a DST gap, where it lands on the pre-transition side.
 */
export function zonedToInstant(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const naive = Date.UTC(y as number, (m as number) - 1, d as number, hh as number, mm as number);
  const firstPass = naive - offsetAt(naive, tz);
  return new Date(naive - offsetAt(firstPass, tz));
}

/** `YYYY-MM-DD` plus N days. Calendar arithmetic; no timezone involved. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y as number, (m as number) - 1, d as number));
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

/** The calendar date `instant` falls on, as seen from `tz`. */
export function dateInZone(instant: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/** The local wall-clock `HH:MM` that `instant` reads as in `tz`. */
export function timeInZone(instant: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).format(instant);
}

/** Canonical weekday order — the DB CHECK's and the contract enum's, not §4.3's. */
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

/** `mon`…`sun` for the calendar date. */
export function weekdayOf(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dow = new Date(Date.UTC(y as number, (m as number) - 1, d as number)).getUTCDay();
  // getUTCDay is Sunday-indexed; WEEKDAYS is Monday-indexed.
  return WEEKDAYS[(dow + 6) % 7] as string;
}
