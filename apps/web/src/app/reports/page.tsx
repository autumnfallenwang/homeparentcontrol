"use client";

import {
  ACTIVE_TIME_EXPLANATION,
  ACTIVE_TIME_LABEL,
  NO_DATA_FOR_PERIOD,
  ZERO_USAGE_FOR_PERIOD,
} from "@hpc/contract";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Card, ErrorNote, NoData, Spinner } from "../../components/ui.js";
import { appName, dayAndTime, humanMinutes } from "../../lib/format.js";
import { getReports, type ReportPayload } from "../../lib/parent-api.js";

/**
 * `/reports` — D.2's **dashboard** sink.
 *
 * ⚠️ Renders from projected rollups, never raw events: raw samples are pruned
 * at 90 days and rollups outlive them, so a report built on raw data would
 * silently lose its own history.
 *
 * ★ §5.7's first honesty rule is the whole visual design here: "**zero usage
 * and no data look identical on a bar chart and mean opposite things**". A
 * bucket nobody reported is hatched and labelled, never drawn as a zero.
 */
export default function ReportsPage() {
  const [grain, setGrain] = useState<"day" | "hour">("day");
  const [payload, setPayload] = useState<ReportPayload | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      setPayload(await getReports({ grain }));
      setError(null);
    } catch (caught) {
      setError(caught);
    }
  }, [grain]);

  useEffect(() => {
    void load();
  }, [load]);

  const peak = Math.max(1, ...(payload?.buckets.map((bucket) => bucket.activeS) ?? [1]));

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:py-10">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <Link href="/" className="text-sm text-slate-500 hover:underline">
            ← Today
          </Link>
          <h1 className="mt-2 text-2xl font-semibold text-slate-900">Reports</h1>
        </div>
        <div className="flex gap-2">
          {(["day", "hour"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setGrain(option)}
              className={`min-h-11 rounded-lg border px-3 text-sm ${
                grain === option
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-300 bg-white text-slate-600"
              }`}
            >
              {option === "day" ? "7 days" : "24 hours"}
            </button>
          ))}
        </div>
      </header>

      {error ? <ErrorNote error={error} /> : null}
      {!payload && !error ? <Spinner /> : null}

      {payload ? (
        <div className="space-y-4">
          <Card>
            <h2 className="font-medium text-slate-900" title={ACTIVE_TIME_EXPLANATION}>
              {ACTIVE_TIME_LABEL}
            </h2>
            {/* ★ The label's explanation, on the page rather than in a
                tooltip. "Screen time" reads as "time the Mac was on". */}
            <p className="mt-1 text-sm text-slate-600">{ACTIVE_TIME_EXPLANATION}</p>
            <p className="mt-3 text-3xl font-semibold tabular-nums text-slate-900">
              {humanMinutes(payload.totals.activeS)}
            </p>
            {payload.totals.gapBuckets > 0 ? (
              <p className="mt-2 text-sm text-amber-800">
                {payload.totals.gapBuckets} of {payload.buckets.length} periods have no data — the
                Mac wasn’t reporting then, so this total is a floor, not the whole picture.
              </p>
            ) : null}
          </Card>

          <Card>
            <h2 className="font-medium text-slate-900">{grain === "day" ? "By day" : "By hour"}</h2>
            {payload.buckets.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500">Nothing recorded for this period.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {payload.buckets.map((bucket) => (
                  <li key={bucket.bucket} className="text-sm">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-slate-600">
                        {grain === "day"
                          ? bucket.bucket
                          : new Date(bucket.bucket).toLocaleTimeString(undefined, {
                              hour: "2-digit",
                            })}
                      </span>
                      <span className="tabular-nums text-slate-900">
                        {bucket.reported ? (
                          bucket.activeS > 0 ? (
                            humanMinutes(bucket.activeS)
                          ) : (
                            <NoData>{ZERO_USAGE_FOR_PERIOD}</NoData>
                          )
                        ) : (
                          <NoData>{NO_DATA_FOR_PERIOD}</NoData>
                        )}
                      </span>
                    </div>
                    {/*
                      ★ The bar. A reported-but-zero bucket draws an empty
                      track; an unreported one draws a HATCH. They must not
                      look the same.
                    */}
                    <div className="mt-1 h-2 overflow-hidden rounded bg-slate-100">
                      {bucket.reported ? (
                        <div
                          className="h-full bg-slate-800"
                          style={{ width: `${Math.round((bucket.activeS / peak) * 100)}%` }}
                        />
                      ) : (
                        <div
                          className="h-full w-full"
                          style={{
                            backgroundImage:
                              "repeating-linear-gradient(45deg, #cbd5e1 0 4px, transparent 4px 8px)",
                          }}
                          title={NO_DATA_FOR_PERIOD}
                        />
                      )}
                    </div>
                    {bucket.reported && bucket.apps.length > 0 ? (
                      <ul className="mt-1 flex flex-wrap gap-x-3 text-xs text-slate-500">
                        {bucket.apps.slice(0, 4).map((app) => (
                          <li key={app.bundleId}>
                            {appName(app.bundleId)} {humanMinutes(app.activeS)}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <h2 className="font-medium text-slate-900">What actually happened</h2>
            {payload.enforcement.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500">
                No warnings, locks or shutdowns in this period.
              </p>
            ) : (
              <ul className="mt-3 space-y-2 text-sm">
                {payload.enforcement.slice(0, 50).map((row) => (
                  <li key={`${row.kind}-${row.at}`} className="flex flex-wrap gap-2">
                    <span className="w-40 shrink-0 text-slate-500">{dayAndTime(row.at)}</span>
                    <span className="text-slate-900">{row.summary}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      ) : null}
    </main>
  );
}
