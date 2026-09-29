"use client";

import { ACTIVE_TIME_EXPLANATION, ACTIVE_TIME_LABEL } from "@hpc/contract";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { HistoryList } from "../../../components/history-list.js";
import { Page } from "../../../components/shell/page.js";
import { useViewing } from "../../../components/shell/viewing.js";
import { Banner, Card, ErrorNote, Field, inputClass, Spinner } from "../../../components/ui.js";
import { humanMinutes } from "../../../lib/format.js";
import { getReports, type ReportPayload } from "../../../lib/parent-api.js";
import { defaultRange, HOURLY_MAX_DAYS, type LocalRange, parseRange } from "../../../lib/range.js";

/**
 * `/reports` — D.2's **dashboard** sink: what one child's Macs did between a
 * start and an end the parent picks.
 *
 * Three summaries and the history, nothing else:
 * - **Active time**, which is use, not uptime (A.33);
 * - **Startups** — how many times the Mac was turned on;
 * - ★ **After bedtime** — what happened during a rule's watch hours (ADR
 *   0014): a startup, a login, or the Mac on but not reporting. Red, as are
 *   those lines in the history; nothing else on the page is.
 *
 * ⚠️ Renders from projected rollups, never raw events: raw samples are pruned
 * at 90 days and rollups outlive them, so a report built on raw data would
 * silently lose its own history.
 *
 * "Collect usage data" moved to Settings › Usage data.
 */
export default function ReportsPage() {
  const viewing = useViewing();
  const childId = viewing.child?.id ?? null;
  const [range, setRange] = useState<LocalRange>(() => defaultRange(new Date()));
  const [payload, setPayload] = useState<ReportPayload | null>(null);
  const [error, setError] = useState<unknown>(null);

  const parsed = parseRange(range);
  // Strings, so the effect below re-runs when the range changes and not on
  // every render's fresh Date objects.
  const from = "error" in parsed ? null : parsed.from.toISOString();
  const to = "error" in parsed ? null : parsed.to.toISOString();
  const grain = "error" in parsed ? null : parsed.grain;

  const load = useCallback(async () => {
    // ⚠️ Never unscoped. Without a child the API would answer for the whole
    // household, and this page would show one child's name over everyone's
    // minutes.
    if (!childId || !from || !to || !grain) return;
    try {
      setPayload(null);
      setPayload(await getReports({ grain, child_id: childId, from, to }));
      setError(null);
    } catch (caught) {
      setError(caught);
    }
  }, [childId, from, to, grain]);

  useEffect(() => {
    void load();
  }, [load]);

  const startups = payload?.totals.startups ?? 0;
  const afterBedtime = payload?.totals.afterBedtime ?? 0;
  const floor = payload?.enforcementTruncated ?? false;

  return (
    <Page title="Activity">
      {error ? <ErrorNote error={error} /> : null}
      {viewing.children !== null && !viewing.child ? (
        <Banner tone="info" title="No children yet">
          Add one in{" "}
          <Link href="/settings/children" className="underline">
            Settings › Children &amp; devices
          </Link>
          .
        </Banner>
      ) : null}

      <Card>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="From" htmlFor="activity-from">
            <input
              id="activity-from"
              type="datetime-local"
              className={inputClass}
              value={range.from}
              onChange={(event) =>
                setRange((current) => ({ ...current, from: event.target.value }))
              }
            />
          </Field>
          <Field label="To" htmlFor="activity-to">
            <input
              id="activity-to"
              type="datetime-local"
              className={inputClass}
              value={range.to}
              onChange={(event) => setRange((current) => ({ ...current, to: event.target.value }))}
            />
          </Field>
        </div>
        {"error" in parsed ? (
          <p className="mt-2 text-sm text-destructive">{parsed.error}</p>
        ) : parsed.grain === "day" ? (
          // ★ Honest about the rounding: past the hourly cap the totals come
          // from daily rollups, so the first and last day count whole.
          <p className="mt-2 text-xs text-muted-foreground">
            Over {HOURLY_MAX_DAYS} days, active time is counted in whole days.
          </p>
        ) : null}
      </Card>

      {viewing.child && !payload && !error && !("error" in parsed) ? <Spinner /> : null}

      {payload ? (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <Card>
              <h2
                className="font-heading text-lg font-medium tracking-tight"
                title={ACTIVE_TIME_EXPLANATION}
              >
                {ACTIVE_TIME_LABEL}
              </h2>
              {/* ★ The label's explanation, on the page rather than in a
                  tooltip. "Screen time" reads as "time the Mac was on". */}
              <p className="mt-1 text-sm text-muted-foreground">{ACTIVE_TIME_EXPLANATION}</p>
              <p className="mt-3 text-3xl font-semibold tabular-nums text-foreground">
                {humanMinutes(payload.totals.activeS)}
              </p>
              {payload.totals.gapBuckets > 0 ? (
                <p className="mt-2 text-sm text-attention-text">
                  {payload.totals.gapBuckets} of {payload.buckets.length} periods have no data — the
                  Mac wasn’t reporting then, so this total is a floor, not the whole picture.
                </p>
              ) : null}
            </Card>

            <Card>
              <h2 className="font-heading text-lg font-medium tracking-tight">Startups</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Times the Mac was turned on in this period.
              </p>
              <p className="mt-3 text-3xl font-semibold tabular-nums text-foreground">
                {floor ? `${startups}+` : startups}
              </p>
            </Card>

            <Card tone={afterBedtime > 0 ? "alarm" : "plain"}>
              <h2 className="font-heading text-lg font-medium tracking-tight">After bedtime</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Startups, logins, or the Mac on but silent, in a rule's watch hours.
              </p>
              <p
                className={`mt-3 text-3xl font-semibold tabular-nums ${
                  afterBedtime > 0 ? "text-destructive" : "text-foreground"
                }`}
              >
                {floor ? `${afterBedtime}+` : afterBedtime}
              </p>
            </Card>
          </div>

          <Card>
            <h2 className="font-heading text-lg font-medium tracking-tight">
              What actually happened
            </h2>
            <HistoryList
              rows={payload.enforcement}
              limit={200}
              empty="No warnings, locks, shutdowns or startups in this period."
            />
            {floor ? (
              <p className="mt-2 text-xs text-muted-foreground">
                This period has more history than one page reads — narrow the range to see all of
                it.
              </p>
            ) : null}
          </Card>
        </div>
      ) : null}
    </Page>
  );
}
