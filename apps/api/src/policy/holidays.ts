import Holidays from "date-holidays";
import type { HolidayHit } from "./types.js";

/**
 * Public holidays, computed live from `date-holidays`.
 *
 * ⚠️ No table, no sync job — §5.6 is emphatic: "a persisted mirror of a pure
 * function creates an idempotency problem, a staleness problem and a 'the
 * library renamed a holiday and now there are two' problem, for a value that
 * costs microseconds to recompute." `calendar_exceptions` stores parent INTENT
 * only: a row exists because a human added, edited or dismissed something.
 *
 * Lifted from `homecal`'s `services/holidays.ts` — same per-country instance
 * cache and `type === "public"` filter, reshaped to the compiler's input type.
 *
 * ⚠️ This is called by `gather`, never by `compile`. Resolving holidays before
 * the compiler runs is what keeps the compiler pure and what stops every
 * golden file rotting on a library bump or a year rollover.
 */

// Constructing a Holidays instance parses that country's rule tables, so cache
// one per country for the process lifetime. The data is static per release.
const instanceCache = new Map<string, Holidays>();

function instanceFor(country: string): Holidays {
  const existing = instanceCache.get(country);
  if (existing) return existing;
  const created = new Holidays(country);
  instanceCache.set(country, created);
  return created;
}

let knownCountries: Set<string> | null = null;

/** ISO 3166-1 alpha-2 codes the library recognises. */
export function isKnownCountry(code: string): boolean {
  if (!knownCountries) {
    knownCountries = new Set(Object.keys(new Holidays().getCountries() as Record<string, string>));
  }
  return knownCountries.has(code);
}

/**
 * Public holidays between two `YYYY-MM-DD` dates inclusive, merged across
 * countries so a date shared by two of them yields one entry.
 *
 * Returns `[]` for an empty or unrecognised country list rather than throwing:
 * `households.holiday_countries` is nullable with no default and no stated
 * behaviour, and a missing country must not be able to fail a compile that
 * `/enroll` runs inside a transaction.
 */
export function getHolidays(countries: string[], from: string, to: string): HolidayHit[] {
  const usable = countries.filter(isKnownCountry);
  if (usable.length === 0) return [];

  const fromYear = Number(from.slice(0, 4));
  const toYear = Number(to.slice(0, 4));
  const byDate = new Map<string, Set<string>>();

  for (const country of usable) {
    const hd = instanceFor(country);
    for (let year = fromYear; year <= toYear; year++) {
      for (const holiday of hd.getHolidays(year) ?? []) {
        if (holiday.type !== "public") continue;
        // `date` is "YYYY-MM-DD HH:mm:ss" in the country's own zone; the
        // calendar date is the only part that matters here.
        const date = holiday.date.slice(0, 10);
        if (date < from || date > to) continue;
        const names = byDate.get(date) ?? new Set<string>();
        names.add(holiday.name);
        byDate.set(date, names);
      }
    }
  }

  return [...byDate.entries()]
    .map(([date, names]) => ({ date, name: [...names].sort().join(" / ") }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Test seam — the instance cache is process-wide and otherwise never cleared. */
export function resetHolidayCache(): void {
  instanceCache.clear();
  knownCountries = null;
}
