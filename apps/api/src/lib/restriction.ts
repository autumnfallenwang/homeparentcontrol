import { addDays, dateInZone, weekdayOf, zonedToInstant } from "../policy/zoned-time.js";

/**
 * Was this moment restricted — and if so, being ENFORCED or being WATCHED?
 * (ADR 0014)
 *
 * - **enforced**: `[from, until)` — the Mac itself locks or shuts down.
 * - **watch**: `[until, watch_until)` — nothing is enforced, but a startup or
 *   a login is something the parent wants flagged.
 *
 * ⚠️ **A mirror of the agent's `BedtimePredicate`, rule for rule** — the same
 * document, the same wrap rule, the same overrides — so the parent's history
 * never calls a moment "after bedtime" that the Mac did not treat as such. It
 * reads the COMPILED document that was in force (holidays, exceptions and
 * grants already folded in), never `schedule_windows`, which is rewritten on
 * every save.
 *
 * Known difference, deliberate: inside a DST gap `zonedToInstant` lands on the
 * pre-transition side where the agent snaps forward — one hour, once a year,
 * of a history label, never of enforcement.
 */

export interface RestrictionDocument {
  timezone?: string;
  schedule?: { windows?: DocumentWindow[] };
  overrides?: DocumentOverride[];
}

interface DocumentWindow {
  id: string;
  label?: string;
  days?: string[];
  restricted_from?: string;
  restricted_until?: string;
  watch_until?: string;
}

interface DocumentOverride {
  type?: string;
  window_id?: string | null;
  minutes?: number | null;
  effective_date?: string;
  expires_at?: string;
}

export interface Restriction {
  phase: "enforced" | "watch";
  windowId: string;
  /** The parent's own name for the rule. */
  label: string;
}

const HHMM = /^(\d{2}):(\d{2})$/;

function minutesOf(time: string): number {
  const match = HHMM.exec(time);
  return match ? Number(match[1]) * 60 + Number(match[2]) : Number.NaN;
}

export function restrictionAt(document: RestrictionDocument, at: Date): Restriction | null {
  const zone = document.timezone ?? "UTC";
  const today = dateInZone(at, zone);
  // Two days back as well as today: an overnight window, and its watch period
  // after it, still apply the next morning.
  const days = [addDays(today, -2), addDays(today, -1), today];

  let enforced: { restriction: Restriction; until: number } | null = null;
  let watched: { restriction: Restriction; until: number } | null = null;

  for (const window of document.schedule?.windows ?? []) {
    if (!window.restricted_from || !window.restricted_until) continue;
    const fromMin = minutesOf(window.restricted_from);
    const untilMin = minutesOf(window.restricted_until);
    if (Number.isNaN(fromMin) || Number.isNaN(untilMin)) continue;

    for (const day of days) {
      if (!(window.days ?? []).includes(weekdayOf(day))) continue;

      let from = zonedToInstant(day, window.restricted_from, zone).getTime();
      // The wrap rule, as the agent derives it: an end not after the start
      // runs into the next local day.
      const untilDay = untilMin <= fromMin ? addDays(day, 1) : day;
      const until = zonedToInstant(untilDay, window.restricted_until, zone).getTime();

      // Live relaxations, exactly as the agent applies them.
      let suspended = false;
      for (const override of document.overrides ?? []) {
        if (!override.expires_at || new Date(override.expires_at).getTime() <= at.getTime()) {
          continue;
        }
        if (override.window_id && override.window_id !== window.id) continue;
        if (override.effective_date !== day) continue;
        if (override.type === "suspend") suspended = true;
        if (override.type === "extend" && override.minutes && override.minutes > 0) {
          // She starts later; the end does not move.
          from = Math.min(from + override.minutes * 60_000, until);
        }
      }
      const effectiveFrom = suspended ? until : from;

      const t = at.getTime();
      const restriction = { windowId: window.id, label: window.label || "Bedtime" };
      if (t >= effectiveFrom && t < until) {
        // Latest-ending window wins when two overlap, as on the Mac.
        if (!enforced || until > enforced.until) {
          enforced = { restriction: { phase: "enforced", ...restriction }, until };
        }
        continue;
      }

      // ── The watch period. A night with no bedtime has no watch either.
      if (!window.watch_until || suspended) continue;
      if (Number.isNaN(minutesOf(window.watch_until))) continue;
      const untilDate = dateInZone(new Date(until), zone);
      let watchEnd = zonedToInstant(untilDate, window.watch_until, zone).getTime();
      if (watchEnd <= until)
        watchEnd = zonedToInstant(addDays(untilDate, 1), window.watch_until, zone).getTime();
      // Overlapping watch periods: the rule whose bedtime ended most recently
      // names it — the same "latest wins" the Mac applies to enforcement.
      if (t >= until && t < watchEnd && (!watched || until > watched.until)) {
        watched = { restriction: { phase: "watch", ...restriction }, until };
      }
    }
  }

  return enforced?.restriction ?? watched?.restriction ?? null;
}
