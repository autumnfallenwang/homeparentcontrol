"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { getSettings, patchSettings } from "../../lib/parent-api.js";
import { Page } from "../shell/page.js";
import { Banner, Card, ErrorNote, Spinner } from "../ui.js";

type Settings = Awaited<ReturnType<typeof getSettings>>;

/**
 * Settings › Usage data — "Collect usage data", one switch per child.
 *
 * It lived on Activity for a while ("it is one child's"); the owner moved it
 * here with the other household settings. Being one per child keeps what
 * made it per-child in the first place.
 *
 * ⚠️ Like the extra-time caps, it is part of the compiled policy, so it
 * reaches the Mac with the next publish — the page says so and links there,
 * rather than announcing "Saved" as if the Mac already knew.
 */
export function UsageDataSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [changed, setChanged] = useState(false);

  const load = useCallback(async () => {
    try {
      setSettings(await getSettings());
      setError(null);
    } catch (caught) {
      setError(caught);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const title = "Usage data";
  if (!settings) {
    return <Page title={title}>{error ? <ErrorNote error={error} /> : <Spinner />}</Page>;
  }

  const setFor = (childId: string) => settings.policy_sets.find((set) => set.childId === childId);

  return (
    <Page
      title={title}
      subtitle="Whether each child's Mac reports which apps are in use. Bedtime is enforced either way."
    >
      {error ? <ErrorNote error={error} /> : null}
      {changed ? (
        <Banner tone="info" title="Saved — not on the Mac yet">
          It reaches the Mac when you next publish.{" "}
          <Link href="/rules" className="underline">
            Review and publish in Rules
          </Link>
          .
        </Banner>
      ) : null}

      <Card>
        {settings.children.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No children yet. Add one in{" "}
            <Link href="/settings/children" className="underline">
              Children &amp; devices
            </Link>
            .
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {settings.children.map((child) => {
              const set = setFor(child.id);
              if (!set) return null;
              return (
                <li key={child.id} className="py-2">
                  <label className="flex min-h-11 items-center gap-3 text-sm">
                    <input
                      type="checkbox"
                      className="size-5 accent-primary"
                      checked={set.telemetryEnabled}
                      onChange={async (event) => {
                        const next = event.target.checked;
                        const flip = (value: boolean) =>
                          setSettings((current) =>
                            current
                              ? {
                                  ...current,
                                  policy_sets: current.policy_sets.map((row) =>
                                    row.id === set.id ? { ...row, telemetryEnabled: value } : row,
                                  ),
                                }
                              : current,
                          );
                        flip(next);
                        try {
                          await patchSettings({ policy_set_id: set.id, telemetry_enabled: next });
                          setChanged(true);
                        } catch (caught) {
                          flip(!next);
                          setError(caught);
                        }
                      }}
                    />
                    <span className="text-foreground">
                      Collect usage data for{" "}
                      <span className="font-medium">{child.displayName}</span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-2 text-sm text-muted-foreground">
          Turning it off stops Activity filling in for that child. It does not change bedtime — the
          rules are enforced either way.
        </p>
      </Card>
    </Page>
  );
}
