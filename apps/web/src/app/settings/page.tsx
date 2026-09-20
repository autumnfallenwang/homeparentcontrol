"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Banner, Card, ErrorNote, Field, inputClass, Spinner } from "../../components/ui.js";
import { getSettings, patchSettings } from "../../lib/parent-api.js";

/**
 * `/settings`.
 *
 * ⚠️ **A.34, and what is deliberately absent.** There is no field here that
 * touches an account, Remote Login, `sudoers` or FileVault, and there is no
 * "disable enforcement" in any spelling (X1) — not hidden, not behind a
 * confirmation, not at all. The nearest legal action is “No bedtime
 * tonight”, which carries a mandatory expiry.
 */
export default function SettingsPage() {
  const [state, setState] = useState<Awaited<ReturnType<typeof getSettings>> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setState(await getSettings());
      setError(null);
    } catch (caught) {
      setError(caught);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!state) return <Shell>{error ? <ErrorNote error={error} /> : <Spinner />}</Shell>;

  return (
    <Shell>
      <header className="mb-6">
        <Link href="/" className="text-sm text-slate-500 hover:underline">
          ← Today
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">Settings</h1>
      </header>

      {error ? (
        <div className="mb-4">
          <ErrorNote error={error} />
        </div>
      ) : null}
      {saved ? (
        <div className="mb-4">
          <Banner tone="ok" title="Saved" />
        </div>
      ) : null}

      <div className="space-y-4">
        {state.policy_sets.map((set) => {
          const child = state.children.find((item) => item.id === set.childId);
          return (
            <Card key={set.id}>
              <h2 className="font-medium text-slate-900">{child?.displayName ?? "Child"}</h2>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label="Extra time allowed per day (minutes)">
                  <input
                    type="number"
                    className={inputClass}
                    defaultValue={set.overrideMaxMinutesPerDay}
                    min={0}
                    max={480}
                    onBlur={async (event) => {
                      await patchSettings({
                        policy_set_id: set.id,
                        override_max_minutes_per_day: Number(event.target.value),
                      });
                      setSaved(true);
                      void refresh();
                    }}
                  />
                </Field>
                <Field label="Grants allowed per day">
                  <input
                    type="number"
                    className={inputClass}
                    defaultValue={set.overrideMaxGrantsPerDay}
                    min={0}
                    max={10}
                    onBlur={async (event) => {
                      await patchSettings({
                        policy_set_id: set.id,
                        override_max_grants_per_day: Number(event.target.value),
                      });
                      setSaved(true);
                      void refresh();
                    }}
                  />
                </Field>
              </div>
              {/* ⚠️ Caps are enforced in the AGENT too, so a server that
                  would happily issue a 6-hour grant cannot produce a UI
                  that lies. */}
              <p className="mt-2 text-xs text-slate-500">
                These caps are applied on the Mac as well as here, so the number above is what
                actually happens.
              </p>

              <label className="mt-4 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  defaultChecked={set.telemetryEnabled}
                  className="size-5"
                  onChange={async (event) => {
                    await patchSettings({
                      policy_set_id: set.id,
                      telemetry_enabled: event.target.checked,
                    });
                    setSaved(true);
                    void refresh();
                  }}
                />
                <span className="text-slate-800">Collect usage data</span>
              </label>
              <p className="mt-1 text-xs text-slate-500">
                Turning this off stops the reports filling in. It does not change bedtime — the
                rules are enforced either way.
              </p>
            </Card>
          );
        })}

        <Card>
          <h2 className="font-medium text-slate-900">Setting up another Mac</h2>
          <p className="mt-1 text-sm text-slate-600">
            <Link href="/setup" className="underline">
              Add a child or a Mac
            </Link>
          </p>
        </Card>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:py-10">{children}</main>;
}
