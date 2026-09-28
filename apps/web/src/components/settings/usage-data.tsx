"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { getSettings, patchSettings } from "../../lib/parent-api.js";
import { Page } from "../shell/page.js";
import { Banner, Card, ErrorNote, Spinner, Toggle } from "../ui.js";

type Settings = Awaited<ReturnType<typeof getSettings>>;

/**
 * Settings › Usage data — one switch, then who it applies to.
 *
 * - **Off:** nothing else is shown, and no child's Mac reports apps.
 * - **On:** a list of children appears, to choose whose Macs report. Turning
 *   it on starts with everyone ticked, so leaving someone out is one untick.
 *
 * No household-level column: the switch reads "on" when any child reports
 * (each child's policy set carries `telemetry_enabled`). Unticking everyone
 * keeps the list open for this visit so the next tick is one click away;
 * next time the page opens, it reads off.
 *
 * ⚠️ Like the extra-time caps, it is part of the compiled policy, so it
 * reaches the Mac with the next publish — the page says so and links there,
 * rather than announcing "Saved" as if the Mac already knew.
 */
export function UsageDataSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [master, setMaster] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [changed, setChanged] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await getSettings();
      setSettings(next);
      setMaster(next.children.some((child) => setFor(next, child.id)?.telemetryEnabled));
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

  /** Set these children's switches, optimistically, and roll back on failure. */
  async function apply(childIds: string[], enabled: boolean) {
    if (!settings) return;
    const sets = childIds
      .map((id) => setFor(settings, id))
      .filter((set): set is NonNullable<typeof set> => !!set && set.telemetryEnabled !== enabled);
    const flip = (ids: Set<string>, value: boolean) =>
      setSettings((current) =>
        current
          ? {
              ...current,
              policy_sets: current.policy_sets.map((row) =>
                ids.has(row.id) ? { ...row, telemetryEnabled: value } : row,
              ),
            }
          : current,
      );
    const ids = new Set(sets.map((set) => set.id));
    flip(ids, enabled);
    setBusy(true);
    try {
      await Promise.all(
        sets.map((set) => patchSettings({ policy_set_id: set.id, telemetry_enabled: enabled })),
      );
      if (sets.length > 0) setChanged(true);
    } catch (caught) {
      flip(ids, !enabled);
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  const everyone = settings.children.map((child) => child.id);

  return (
    <Page
      title={title}
      subtitle="Which apps each child's Mac is using. Bedtime is enforced either way."
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
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="font-medium text-foreground">Collect usage data</p>
            <p className="text-sm text-muted-foreground">
              Fills in Activity and the apps on each Today card.
            </p>
          </div>
          <Toggle
            label="Collect usage data"
            checked={master}
            disabled={busy || everyone.length === 0}
            onChange={async (next) => {
              setMaster(next);
              await apply(everyone, next);
            }}
          />
        </div>

        {master ? (
          <div className="mt-4 border-t border-border pt-3">
            <p className="text-[13px] font-medium text-foreground/80">For</p>
            <ul className="mt-1">
              {settings.children.map((child) => {
                const set = setFor(settings, child.id);
                if (!set) return null;
                return (
                  <li key={child.id}>
                    <label className="flex min-h-11 items-center gap-3 text-sm">
                      <input
                        type="checkbox"
                        className="size-5 accent-primary"
                        checked={set.telemetryEnabled}
                        disabled={busy}
                        onChange={(event) => void apply([child.id], event.target.checked)}
                      />
                      <span className="text-foreground">{child.displayName}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </Card>
    </Page>
  );
}

function setFor(settings: Settings, childId: string) {
  return settings.policy_sets.find((set) => set.childId === childId);
}
