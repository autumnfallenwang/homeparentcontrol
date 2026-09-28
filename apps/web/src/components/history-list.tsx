"use client";

import { dateAndTime } from "../lib/format.js";
import type { HistoryItem } from "../lib/parent-api.js";

/**
 * "What actually happened" — one list for the device page and Activity, so
 * the two cannot drift in what they show red.
 *
 * ★ The owner asked for startups (and shutdowns) to stand out. `alarm` rows
 * are the Mac turning on or off; everything else stays quiet so they do.
 */
export function HistoryList({
  rows,
  limit,
  empty,
}: {
  rows: HistoryItem[];
  limit: number;
  empty: string;
}) {
  if (rows.length === 0) return <p className="mt-2 text-sm text-muted-foreground">{empty}</p>;
  const shown = rows.slice(0, limit);
  // Two lines can share an instant and a kind (a lock every minute, two in
  // one second); a running count per pair keeps the keys unique and stable.
  const seen = new Map<string, number>();
  const keyed = shown.map((row) => {
    const base = `${row.at}-${row.kind}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { row, key: `${base}-${n}` };
  });
  return (
    <>
      <ul className="mt-3 space-y-1 text-sm">
        {keyed.map(({ row, key }) => (
          <li
            key={key}
            className={`flex flex-wrap gap-x-3 gap-y-0.5 rounded-md px-2 py-1 ${
              row.tone === "alarm" ? "bg-destructive/[0.08]" : ""
            }`}
          >
            <span className="w-44 shrink-0 tabular-nums text-muted-foreground">
              {dateAndTime(row.at)}
            </span>
            <span
              className={row.tone === "alarm" ? "font-medium text-destructive" : "text-foreground"}
            >
              {row.summary}
            </span>
          </li>
        ))}
      </ul>
      {rows.length > shown.length ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Showing the latest {shown.length} of {rows.length}.
        </p>
      ) : null}
    </>
  );
}
