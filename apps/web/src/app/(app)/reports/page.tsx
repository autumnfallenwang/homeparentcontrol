"use client";

import {
  ACTIVE_TIME_EXPLANATION,
  ACTIVE_TIME_LABEL,
  NO_DATA_FOR_PERIOD,
  ZERO_USAGE_FOR_PERIOD,
} from "@hpc/contract";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Page, SectionTitle } from "../../../components/shell/page.js";
import { useViewing } from "../../../components/shell/viewing.js";
import { Banner, Card, ErrorNote, NoData, Spinner } from "../../../components/ui.js";
import { appName, dayAndTime, humanMinutes } from "../../../lib/format.js";
import {
  getReports,
  getSettings,
  patchSettings,
  type ReportPayload,
} from "../../../lib/parent-api.js";

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
 *
 * About the child picked in the Viewing switch — and it carries that child's
 * "Collect usage data" switch, the one thing that decides whether this page
 * fills in at all.
 */
export default function ReportsPage() {
  const viewing = useViewing();
  const childId = viewing.child?.id ?? null;
  const [grain, setGrain] = useState<"day" | "hour">("day");
  const [payload, setPayload] = useState<ReportPayload | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    // ⚠️ Never unscoped. Without a child the API would answer for the whole
    // household, and this page would show one child's name over everyone's
    // minutes.
    if (!childId) return;
    try {
      setPayload(null);
      setPayload(await getReports({ grain, child_id: childId }));
      setError(null);
    } catch (caught) {
      setError(caught);
    }
  }, [grain, childId]);

  useEffect(() => {
    void load();
  }, [load]);

  const peak = Math.max(1, ...(payload?.buckets.map((bucket) => bucket.activeS) ?? [1]));

  return (
    <Page
      title="Activity"
      actions={
        <div className="flex gap-2">
          {(["day", "hour"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setGrain(option)}
              className={`min-h-11 rounded-lg border px-3 text-sm ${
                grain === option
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-card text-muted-foreground"
              }`}
            >
              {option === "day" ? "7 days" : "24 hours"}
            </button>
          ))}
        </div>
      }
    >
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
      {viewing.child && !payload && !error ? <Spinner /> : null}

      {payload ? (
        <div className="space-y-4">
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
            <h2 className="font-heading text-lg font-medium tracking-tight">
              {grain === "day" ? "By day" : "By hour"}
            </h2>
            {payload.buckets.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">
                Nothing recorded for this period.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {payload.buckets.map((bucket) => (
                  <li key={bucket.bucket} className="text-sm">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-muted-foreground">
                        {grain === "day"
                          ? bucket.bucket
                          : new Date(bucket.bucket).toLocaleTimeString(undefined, {
                              hour: "2-digit",
                            })}
                      </span>
                      <span className="tabular-nums text-foreground">
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
                    <div className="mt-1 h-2 overflow-hidden rounded bg-secondary">
                      {bucket.reported ? (
                        <div
                          className="h-full bg-primary"
                          style={{ width: `${Math.round((bucket.activeS / peak) * 100)}%` }}
                        />
                      ) : (
                        <div
                          className="h-full w-full"
                          style={{
                            backgroundImage:
                              "repeating-linear-gradient(45deg, color-mix(in oklch, var(--muted-foreground) 40%, transparent) 0 4px, transparent 4px 8px)",
                          }}
                          title={NO_DATA_FOR_PERIOD}
                        />
                      )}
                    </div>
                    {bucket.reported && bucket.apps.length > 0 ? (
                      <ul className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
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
            <h2 className="font-heading text-lg font-medium tracking-tight">
              What actually happened
            </h2>
            {payload.enforcement.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">
                No warnings, locks or shutdowns in this period.
              </p>
            ) : (
              <ul className="mt-3 space-y-2 text-sm">
                {payload.enforcement.slice(0, 50).map((row) => (
                  <li key={`${row.kind}-${row.at}`} className="flex flex-wrap gap-2">
                    <span className="w-40 shrink-0 text-muted-foreground">
                      {dayAndTime(row.at)}
                    </span>
                    <span className="text-foreground">{row.summary}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      ) : null}

      {childId ? <UsageSwitch key={childId} childId={childId} /> : null}
    </Page>
  );
}

/**
 * "Collect usage data" — moved here from Settings: it is one child's, and it
 * is the switch that decides whether this page fills in.
 *
 * ⚠️ Like the extra-time caps, it is part of the compiled policy, so it
 * reaches the Mac with the next publish — the page says so and links there,
 * rather than announcing "Saved" as if the Mac already knew.
 */
function UsageSwitch({ childId }: { childId: string }) {
  const [setId, setSetId] = useState<string | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    void (async () => {
      try {
        const settings = await getSettings();
        const set = settings.policy_sets.find((candidate) => candidate.childId === childId);
        setSetId(set?.id ?? null);
        setEnabled(set?.telemetryEnabled ?? null);
      } catch (caught) {
        setError(caught);
      }
    })();
  }, [childId]);

  if (error) return <ErrorNote error={error} />;
  if (enabled === null || !setId) return null;

  return (
    <Card>
      <SectionTitle>Usage data</SectionTitle>
      <label className="mt-3 flex min-h-11 items-center gap-3 text-sm">
        <input
          type="checkbox"
          className="size-5 accent-primary"
          checked={enabled}
          onChange={async (event) => {
            const next = event.target.checked;
            setEnabled(next);
            try {
              await patchSettings({ policy_set_id: setId, telemetry_enabled: next });
              setChanged(true);
            } catch (caught) {
              setEnabled(!next);
              setError(caught);
            }
          }}
        />
        <span className="text-foreground">Collect usage data</span>
      </label>
      <p className="mt-1 text-sm text-muted-foreground">
        Turning this off stops this page filling in. It does not change bedtime — the rules are
        enforced either way.
      </p>
      {changed ? (
        <div className="mt-3">
          <Banner tone="info" title="Saved — not on the Mac yet">
            It reaches the Mac when you next publish.{" "}
            <Link href="/rules" className="underline">
              Review and publish in Rules
            </Link>
            .
          </Banner>
        </div>
      ) : null}
    </Card>
  );
}
