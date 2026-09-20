"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { GrantButtons, type PendingGrant } from "../components/grant-buttons.js";
import { HealthCard } from "../components/health-card.js";
import { Banner, ErrorNote, Spinner } from "../components/ui.js";
import { type DeviceCard, getToday } from "../lib/parent-api.js";

/**
 * `/` — Today.
 *
 * §5.8: "one card per device, health in plain language, tonight's boundary
 * with overrides folded in, today's screen time, one tripwire banner not
 * eight, and the 15/30/60 grant buttons right here because this is the page
 * open when the child asks".
 */

/**
 * ⚠️ Five seconds, and only while a grant is in flight.
 *
 * The rest of the time this page polls slowly: it is often left open on a
 * kitchen tablet for hours, and a permanent 5-second poll would be a
 * self-inflicted load with nobody reading the result. The fast poll exists
 * to catch the `sent → applied` transition, which is the one moment someone
 * is actually watching the screen.
 */
const IDLE_POLL_MS = 30_000;
const WATCHING_POLL_MS = 5_000;

export default function TodayPage() {
  const [cards, setCards] = useState<DeviceCard[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState<Record<string, PendingGrant>>({});

  const refresh = useCallback(async () => {
    try {
      const body = await getToday();
      setCards(body.devices);
      setError(null);
    } catch (caught) {
      setError(caught);
    }
  }, []);

  const watching = Object.keys(pending).length > 0;

  useEffect(() => {
    void refresh();
    const interval = setInterval(refresh, watching ? WATCHING_POLL_MS : IDLE_POLL_MS);
    return () => clearInterval(interval);
  }, [refresh, watching]);

  // Retire a grant's progress banner once the agent has confirmed it, so the
  // page settles instead of polling at 5 s for ever.
  useEffect(() => {
    if (!cards) return;
    setPending((current) => {
      const next = { ...current };
      let changed = false;
      for (const card of cards) {
        const grant = next[card.device_id];
        const target = grant?.result.awaiting_policy_version;
        if (
          grant &&
          target !== null &&
          target !== undefined &&
          (card.health.applied_policy_version ?? -1) >= target &&
          Date.now() - grant.sentAt > 8_000
        ) {
          delete next[card.device_id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [cards]);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:py-10">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-2xl font-semibold text-slate-900">Today</h1>
        <nav className="flex gap-3 text-sm">
          <Link href="/rules" className="text-slate-600 hover:text-slate-900 hover:underline">
            Rules
          </Link>
          <Link href="/reports" className="text-slate-600 hover:text-slate-900 hover:underline">
            Reports
          </Link>
          <Link href="/settings" className="text-slate-600 hover:text-slate-900 hover:underline">
            Settings
          </Link>
        </nav>
      </header>

      {error ? <ErrorNote error={error} /> : null}
      {cards === null && !error ? <Spinner /> : null}

      {cards?.length === 0 ? (
        <Banner tone="info" title="No Macs yet">
          <Link href="/setup" className="underline">
            Set one up
          </Link>
        </Banner>
      ) : null}

      <div className="space-y-4">
        {cards?.map((card) => (
          <HealthCard key={card.device_id} card={card}>
            <GrantButtons
              card={card}
              pending={pending[card.device_id] ?? null}
              onGranted={(grant) => {
                setPending((current) => ({ ...current, [card.device_id]: grant }));
                void refresh();
              }}
              onError={setError}
            />
          </HealthCard>
        ))}
      </div>
    </main>
  );
}
