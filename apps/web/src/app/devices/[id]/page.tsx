"use client";

import { DECOMMISSION, type DestructiveAction, healthPhrasing, REVOKE } from "@hpc/contract";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  Banner,
  Button,
  Card,
  ErrorNote,
  Field,
  inputClass,
  Spinner,
} from "../../../components/ui.js";
import { dayAndTime, humanDuration, weekdayOf } from "../../../lib/format.js";
import {
  attendDevice,
  type DeviceDetail,
  decommissionDevice,
  getDevice,
  revokeDevice,
  setAway,
} from "../../../lib/parent-api.js";

/**
 * `/devices/[id]`.
 *
 * §5.8: "**opening it sets `attendedUntil = now() + 10 min`**, which is the
 * whole mechanism behind the 5-second grant; 7-day state timeline; clock
 * posture; **Away until…**; Revoke / Re-enrol / Decommission".
 */

const POLL_MS = 5_000;

export default function DevicePage() {
  const params = useParams<{ id: string }>();
  const deviceId = params.id;
  const [detail, setDetail] = useState<DeviceDetail | null>(null);
  const [error, setError] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    try {
      setDetail(await getDevice(deviceId));
      setError(null);
    } catch (caught) {
      setError(caught);
    }
  }, [deviceId]);

  /**
   * ★ The attended flag, set explicitly on mount.
   *
   * ⚠️ A separate POST rather than a side effect of the read. A GET that
   * writes fires on Next.js prefetch, on a speculative load and on a
   * monitoring probe — each one putting the device into 5-second polling for
   * ten minutes with nobody looking at anything. This runs when a human
   * opens the page and at no other time.
   *
   * Re-sent every 5 minutes so a page left open stays attended, which is
   * what makes the grant on this page land in ~5 s rather than ~60.
   */
  useEffect(() => {
    let cancelled = false;
    const mark = () => {
      if (!cancelled) void attendDevice(deviceId).catch(() => undefined);
    };
    mark();
    const interval = setInterval(mark, 5 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [deviceId]);

  useEffect(() => {
    void refresh();
    const interval = setInterval(refresh, POLL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  if (error && !detail)
    return (
      <Shell>
        <ErrorNote error={error} />
      </Shell>
    );
  if (!detail)
    return (
      <Shell>
        <Spinner />
      </Shell>
    );

  const subject = {
    childName: detail.device.child?.display_name ?? "your child",
    deviceLabel: detail.device.label ?? "This Mac",
  };
  const silentFor = detail.health.last_sync_at
    ? humanDuration((Date.now() - new Date(detail.health.last_sync_at).getTime()) / 1000)
    : "unknown";
  const phrasing = healthPhrasing(detail.health.state, subject, {
    silentFor,
    lastPolicyDay: weekdayOf(detail.health.last_sync_at),
  });

  return (
    <Shell>
      <header className="mb-6">
        <Link href="/" className="text-sm text-slate-500 hover:underline">
          ← Today
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">
          {detail.device.label ?? "Unnamed Mac"}
        </h1>
        <p className="text-sm text-slate-600">
          {detail.device.child?.display_name} · {detail.device.status}
        </p>
      </header>

      {error ? (
        <div className="mb-4">
          <ErrorNote error={error} />
        </div>
      ) : null}

      <div className="space-y-4">
        <Card tone={phrasing.tone}>
          <p className="font-medium text-slate-900">{phrasing.headline}</p>
          {phrasing.reassurance ? (
            <p className="mt-1 text-sm text-slate-700">{phrasing.reassurance}</p>
          ) : null}
          <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
            <Pair label="Last check-in" value={dayAndTime(detail.health.last_sync_at)} />
            <Pair label="Policy version" value={detail.device.applied_policy_version ?? "—"} />
            <Pair label="Agent" value={detail.device.agent_version ?? "—"} />
            <Pair label="Self-reported" value={detail.health.self_reported_reason ?? "—"} />
          </dl>
          {detail.device.attended_until && new Date(detail.device.attended_until) > new Date() ? (
            <p className="mt-3 text-xs text-slate-500">
              While this page is open the Mac checks in every 5 seconds, so a grant lands almost
              immediately.
            </p>
          ) : null}
        </Card>

        {/* §5.8's "clock posture" — the first thing to look at when the
            question is "has the clock been moved?" */}
        <Card>
          <h2 className="font-medium text-slate-900">Clock and boot</h2>
          <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
            <Pair label="Booted" value={dayAndTime(detail.clock.system_boot_time)} />
            <Pair label="Boot id" value={detail.clock.last_boot_id?.slice(0, 8) ?? "—"} />
            <Pair label="Model" value={detail.device.model ?? "—"} />
            <Pair label="macOS" value={detail.device.os_version ?? "—"} />
          </dl>
        </Card>

        <AwayCard detail={detail} onChanged={refresh} />
        <TimelineCard detail={detail} />
        <EnforcementCard detail={detail} />
        <TripwiresCard detail={detail} />
        <DangerCard detail={detail} onChanged={refresh} />
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:py-10">{children}</main>;
}

function Pair({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-medium text-slate-900">{value}</dd>
    </div>
  );
}

/**
 * **Away until…** (X6 / A.19).
 *
 * ⚠️ The only legitimate way to silence the offline alarm, and it has an end
 * date by construction. The alternative a parent reaches for otherwise is
 * turning notifications off, which never gets turned back on.
 */
function AwayCard({ detail, onChanged }: { detail: DeviceDetail; onChanged: () => void }) {
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const active = detail.device.away_until && new Date(detail.device.away_until) > new Date();

  return (
    <Card tone={active ? "info" : "plain"}>
      <h2 className="font-medium text-slate-900">Away until…</h2>
      <p className="mt-1 text-sm text-slate-600">
        Stops the “hasn’t checked in” alerts while the Mac is legitimately off. It does not change
        the rules, and it always has an end date.
      </p>
      {active ? (
        <p className="mt-2 text-sm font-medium text-sky-800">
          Away until {new Date(detail.device.away_until ?? "").toLocaleString()}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <Field label="Until">
          <input
            type="datetime-local"
            className={inputClass}
            value={until}
            onChange={(event) => setUntil(event.target.value)}
          />
        </Field>
        <Button
          disabled={!until || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await setAway(detail.device.id, new Date(until).toISOString());
              setUntil("");
              onChanged();
            } finally {
              setBusy(false);
            }
          }}
        >
          Set
        </Button>
      </div>
    </Card>
  );
}

/** The 7-day state timeline. */
function TimelineCard({ detail }: { detail: DeviceDetail }) {
  return (
    <Card>
      <h2 className="font-medium text-slate-900">Last 7 days</h2>
      {detail.timeline.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">Nothing recorded yet.</p>
      ) : (
        <ul className="mt-3 space-y-2 text-sm">
          {detail.timeline.slice(0, 40).map((row) => (
            <li key={`${row.state}-${row.entered_at}`} className="flex flex-wrap gap-2">
              <span className="w-40 shrink-0 text-slate-500">{dayAndTime(row.entered_at)}</span>
              <span className="font-medium text-slate-900">{row.state}</span>
              {row.reason ? <span className="text-slate-600">{row.reason}</span> : null}
              {/* ⚠️ Kept visible: a silence later reclassified as expected is
                  a different story from one that was expected all along. */}
              {row.reclassified_from ? (
                <span className="text-slate-400">(was {row.reclassified_from})</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function EnforcementCard({ detail }: { detail: DeviceDetail }) {
  return (
    <Card>
      <h2 className="font-medium text-slate-900">What actually happened</h2>
      {detail.enforcement.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">Nothing in the last 7 days.</p>
      ) : (
        <ul className="mt-3 space-y-2 text-sm">
          {detail.enforcement.slice(0, 40).map((row) => (
            <li key={`${row.kind}-${row.at}`} className="flex flex-wrap gap-2">
              <span className="w-40 shrink-0 text-slate-500">{dayAndTime(row.at)}</span>
              <span className="text-slate-900">{row.summary}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function TripwiresCard({ detail }: { detail: DeviceDetail }) {
  if (detail.tripwires.length === 0) return null;
  return (
    <Card>
      <h2 className="font-medium text-slate-900">Noticed</h2>
      <p className="mt-1 text-sm text-slate-600">
        These are recorded so the history exists, not because anything needs doing.
      </p>
      <ul className="mt-3 space-y-2 text-sm">
        {detail.tripwires.map((row) => (
          <li key={row.id} className="flex flex-wrap gap-2">
            <span className="w-40 shrink-0 text-slate-500">{dayAndTime(row.last_seen_at)}</span>
            <span className="text-slate-900">{row.kind}</span>
            <span className="text-slate-500">×{row.occurrences}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * ★ Revoke and Decommission (§5.5).
 *
 * ⚠️ "The UI must make these typed-confirmation actions and must say what
 * each does, because they look similar and behave oppositely." Both the
 * description and the confirm word come from `@hpc/contract`, and the server
 * checks the word again — a confirmation only the browser enforces is one
 * anyone can skip.
 */
function DangerCard({ detail, onChanged }: { detail: DeviceDetail; onChanged: () => void }) {
  return (
    <Card tone="alarm">
      <h2 className="font-medium text-red-900">Ending this Mac’s enrolment</h2>
      <div className="mt-3 space-y-4">
        <DestructiveRow
          action={REVOKE}
          deviceId={detail.device.id}
          run={revokeDevice}
          onChanged={onChanged}
        />
        <DestructiveRow
          action={DECOMMISSION}
          deviceId={detail.device.id}
          run={decommissionDevice}
          onChanged={onChanged}
        />
      </div>
    </Card>
  );
}

function DestructiveRow({
  action,
  deviceId,
  run,
  onChanged,
}: {
  action: DestructiveAction;
  deviceId: string;
  run: (id: string, confirm: string) => Promise<unknown>;
  onChanged: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  return (
    <div className="rounded-lg border border-red-200 bg-white p-3">
      <p className="font-medium text-slate-900">{action.label}</p>
      {/* ★ What it actually does, in the spec's own words — and the two say
          opposite things about enforcement. */}
      <p className="mt-1 text-sm text-slate-700">{action.description}</p>
      <p className="text-sm text-slate-500">{action.useWhen}</p>
      {done ? (
        <Banner tone="ok" title={`${action.label} done`}>
          {action.stopsEnforcement
            ? "This Mac will stop enforcing on its next check-in."
            : "This Mac keeps enforcing the rules it already has."}
        </Banner>
      ) : (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <Field label={`Type ${action.confirmWord} to confirm`}>
            <input
              className={inputClass}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder={action.confirmWord}
              autoComplete="off"
            />
          </Field>
          <Button
            variant="danger"
            disabled={typed !== action.confirmWord || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await run(deviceId, typed);
                setDone(true);
                onChanged();
              } finally {
                setBusy(false);
              }
            }}
          >
            {action.label}
          </Button>
        </div>
      )}
    </div>
  );
}
