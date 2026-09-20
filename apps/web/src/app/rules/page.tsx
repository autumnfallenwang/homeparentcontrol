"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  Banner,
  Button,
  Card,
  ErrorNote,
  Field,
  inputClass,
  Spinner,
} from "../../components/ui.js";
import { DAY_LABEL, DAYS, dayAndTime } from "../../lib/format.js";
import {
  getRules,
  getRulesDiff,
  getRulesHistory,
  publishRules,
  type RulesPayload,
  type RuleWindow,
  restoreVersion,
  saveRules,
} from "../../lib/parent-api.js";

/**
 * `/rules` — draft → diff → publish, plus `/rules/history` inline.
 *
 * ★ **The diff shows the COMPILED document**, because that is what the agent
 * obeys. A diff of the windows the parent just edited would hide the
 * holidays, the calendar exceptions and the live grants the compiler folds
 * in — so a parent could move bedtime and never learn that Monday is a
 * holiday and the window is suspended anyway.
 */
export default function RulesPage() {
  const [rules, setRules] = useState<RulesPayload | null>(null);
  const [windows, setWindows] = useState<RuleWindow[]>([]);
  const [setId, setSetId] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string>("");
  const [diff, setDiff] = useState<Awaited<ReturnType<typeof getRulesDiff>> | null>(null);
  const [history, setHistory] = useState<Awaited<ReturnType<typeof getRulesHistory>> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const payload = await getRules();
        setRules(payload);
        const first = payload.policy_sets[0];
        if (first) {
          setSetId(first.id);
          setWindows(first.windows);
        }
      } catch (caught) {
        setError(caught);
      }
    })();
  }, []);

  // A device is needed to compile against — the document is per device.
  useEffect(() => {
    void (async () => {
      const response = await fetch("/api/parent/v1/devices", { credentials: "include" }).catch(
        () => null,
      );
      if (!response?.ok) return;
      const body = (await response.json()) as { devices: { id: string }[] };
      setDeviceId((current) => current || (body.devices[0]?.id ?? ""));
    })();
  }, []);

  const loadDiff = useCallback(async () => {
    if (!deviceId) return;
    setBusy(true);
    try {
      setDiff(await getRulesDiff(deviceId));
      setHistory(await getRulesHistory(deviceId));
      setError(null);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }, [deviceId]);

  useEffect(() => {
    void loadDiff();
  }, [loadDiff]);

  if (!rules) return <Shell>{error ? <ErrorNote error={error} /> : <Spinner />}</Shell>;

  return (
    <Shell>
      <header className="mb-6">
        <Link href="/" className="text-sm text-slate-500 hover:underline">
          ← Today
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">Rules</h1>
      </header>

      {error ? (
        <div className="mb-4">
          <ErrorNote error={error} />
        </div>
      ) : null}

      <div className="space-y-4">
        <Card>
          <h2 className="font-medium text-slate-900">Bedtime windows</h2>
          <div className="mt-4 space-y-4">
            {windows.map((window, index) => (
              <WindowEditor
                key={window.id ?? `new-${index}`}
                window={window}
                onChange={(next) =>
                  setWindows((current) =>
                    current.map((item, position) => (position === index ? next : item)),
                  )
                }
                onRemove={() =>
                  setWindows((current) => current.filter((_, position) => position !== index))
                }
              />
            ))}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              onClick={() =>
                setWindows((current) => [
                  ...current,
                  {
                    label: "New window",
                    days: ["mon", "tue", "wed", "thu"],
                    restricted_from: "21:30",
                    restricted_until: "07:00",
                    action: "lock",
                    shutdown_grace_s: 300,
                    escalate_after_failures: 3,
                    warnings: [
                      { lead_minutes: 30, channel: "banner" },
                      { lead_minutes: 15, channel: "banner" },
                      { lead_minutes: 5, channel: "modal" },
                      { lead_minutes: 1, channel: "modal" },
                    ],
                  },
                ])
              }
            >
              Add a window
            </Button>
            <Button
              variant="primary"
              disabled={!setId || busy}
              onClick={async () => {
                if (!setId) return;
                setBusy(true);
                try {
                  await saveRules(setId, windows);
                  setSaved(true);
                  await loadDiff();
                } catch (caught) {
                  setError(caught);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Save draft
            </Button>
          </div>
          {/* ⚠️ Saving is not publishing, and the UI has to say so — a parent
              who thinks "Save" shipped it will not press "Publish". */}
          {saved ? (
            <p className="mt-2 text-sm text-slate-600">
              Saved as a draft. Nothing has reached the Mac yet — review the change below and
              publish it.
            </p>
          ) : null}
        </Card>

        {diff ? (
          <Card tone={diff.confirm_immediate_effect ? "warn" : "plain"}>
            <h2 className="font-medium text-slate-900">What the Mac will obey</h2>
            <p className="mt-1 text-sm text-slate-600">
              This is the compiled policy — holidays, calendar exceptions and tonight’s grants
              already folded in. It is what the agent actually reads.
            </p>

            {!diff.changed ? (
              <p className="mt-3 text-sm text-slate-600">
                No change — the Mac already has these rules.
              </p>
            ) : null}

            {/*
              ★ C3. The guard fires ONLY on a tightening that bites within 15
              minutes. "Firing the guard on every +30-minute grant trains the
              parent to click through it in exactly the case it was built for."
            */}
            {diff.confirm_immediate_effect ? (
              <div className="mt-3">
                <Banner tone="warn" title="This takes effect almost immediately">
                  {diff.confirm_reason ??
                    "A window is about to start. Publishing now could lock the Mac mid-use."}
                </Banner>
              </div>
            ) : null}

            <details className="mt-3">
              <summary className="cursor-pointer text-sm text-slate-600">
                Show the compiled document
              </summary>
              <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">
                {JSON.stringify(diff.proposed_document, null, 2)}
              </pre>
            </details>

            <div className="mt-4">
              <Button
                variant="primary"
                disabled={!diff.changed || busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await publishRules(deviceId, diff.confirm_immediate_effect);
                    setSaved(false);
                    await loadDiff();
                  } catch (caught) {
                    setError(caught);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {diff.confirm_immediate_effect ? "Publish anyway" : "Publish"}
              </Button>
            </div>
          </Card>
        ) : null}

        {history ? (
          <Card>
            <h2 className="font-medium text-slate-900">History</h2>
            {/* ⚠️ Restore publishes a NEW version with the old content. It
                never rewinds — `git revert` applied to bedtime. */}
            <p className="mt-1 text-sm text-slate-600">
              Restoring publishes a new version with the old rules. Nothing in this list ever
              changes.
            </p>
            <ul className="mt-3 space-y-2 text-sm">
              {history.versions.map((version) => (
                <li key={version.version} className="flex flex-wrap items-center gap-3">
                  <span className="w-12 shrink-0 tabular-nums text-slate-500">
                    v{version.version}
                  </span>
                  <span className="w-40 shrink-0 text-slate-500">
                    {dayAndTime(version.issued_at)}
                  </span>
                  <span className="text-slate-700">{version.reason ?? "—"}</span>
                  <Button
                    variant="quiet"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await restoreVersion(deviceId, version.version);
                        await loadDiff();
                      } catch (caught) {
                        setError(caught);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Restore
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:py-10">{children}</main>;
}

function WindowEditor({
  window,
  onChange,
  onRemove,
}: {
  window: RuleWindow;
  onChange: (next: RuleWindow) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <input
            className={inputClass}
            value={window.label}
            onChange={(event) => onChange({ ...window, label: event.target.value })}
          />
        </Field>
        <Field label="Action">
          {/*
            ⚠️ Two values, and that is A.34 made visible. The vocabulary IS
            the boundary: nothing here can express "disable Remote Login" or
            "change FileVault". A third option is a schema migration and an
            ADR, not a dropdown entry.
          */}
          <select
            className={inputClass}
            value={window.action}
            onChange={(event) =>
              onChange({ ...window, action: event.target.value as "lock" | "shutdown" })
            }
          >
            <option value="lock">Lock the screen</option>
            <option value="shutdown">Lock, then shut down</option>
          </select>
        </Field>
        <Field label="From">
          <input
            type="time"
            className={inputClass}
            value={window.restricted_from}
            onChange={(event) => onChange({ ...window, restricted_from: event.target.value })}
          />
        </Field>
        <Field label="Until">
          <input
            type="time"
            className={inputClass}
            value={window.restricted_until}
            onChange={(event) => onChange({ ...window, restricted_until: event.target.value })}
          />
        </Field>
      </div>

      <fieldset className="mt-3">
        <legend className="mb-1 text-sm font-medium text-slate-700">Nights</legend>
        <div className="flex flex-wrap gap-1">
          {DAYS.map((day) => {
            const on = window.days.includes(day);
            return (
              <button
                key={day}
                type="button"
                onClick={() =>
                  onChange({
                    ...window,
                    days: on ? window.days.filter((item) => item !== day) : [...window.days, day],
                  })
                }
                className={`min-h-11 min-w-11 rounded-lg border px-2 text-sm ${
                  on
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-slate-300 bg-white text-slate-600"
                }`}
              >
                {DAY_LABEL[day]}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="mt-3">
        <Button variant="quiet" onClick={onRemove}>
          Remove this window
        </Button>
      </div>
    </div>
  );
}
