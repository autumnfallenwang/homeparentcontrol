/**
 * The Activity page's Start–End filter.
 *
 * `<input type="datetime-local">` speaks "YYYY-MM-DDTHH:mm" in the BROWSER's
 * local time, with no zone. `new Date(value)` reads it in that same local
 * time, so a parent picking "9 pm" gets 9 pm where they are — which is what
 * they meant.
 */

export type Grain = "hour" | "day";

export interface LocalRange {
  from: string;
  to: string;
}

export type ParsedRange = { from: Date; to: Date; grain: Grain } | { error: string };

const DAY_MS = 86_400_000;
/** The API's cap for hourly grain; past it, the report reads daily rollups. */
export const HOURLY_MAX_DAYS = 31;
/** The API's cap for any report — rollups are kept this long. */
export const RANGE_MAX_DAYS = 400;

const pad = (n: number) => String(n).padStart(2, "0");

/** A Date as the `datetime-local` value for the browser's own time zone. */
export function toLocalInput(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** The last 7 days, ending now. */
export function defaultRange(now: Date): LocalRange {
  return { from: toLocalInput(new Date(now.getTime() - 7 * DAY_MS)), to: toLocalInput(now) };
}

export function parseRange(range: LocalRange): ParsedRange {
  const from = new Date(range.from);
  const to = new Date(range.to);
  if (!range.from || !range.to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return { error: "Pick a start and an end." };
  }
  if (from >= to) return { error: "The start has to be before the end." };
  const span = to.getTime() - from.getTime();
  if (span > RANGE_MAX_DAYS * DAY_MS) {
    return { error: `Pick a range of ${RANGE_MAX_DAYS} days or less.` };
  }
  return { from, to, grain: span <= HOURLY_MAX_DAYS * DAY_MS ? "hour" : "day" };
}
