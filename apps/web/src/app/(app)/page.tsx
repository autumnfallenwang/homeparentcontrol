"use client";

import { shadowModeNotEnforcing } from "@hpc/contract";
import { CheckCircle2, CircleAlert } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { GrantButtons, type PendingGrant } from "../../components/grant-buttons.js";
import { cardPhrasing, cardSubject, HealthCard } from "../../components/health-card.js";
import { Page } from "../../components/shell/page.js";
import { Banner, ErrorNote, Spinner, type Tone } from "../../components/ui.js";
import { humanMinutes } from "../../lib/format.js";
import { settlePending } from "../../lib/grant-progress.js";
import { type DeviceCard, getToday } from "../../lib/parent-api.js";

/**
 * `/` — Today.
 *
 * §5.8: "one card per device, health in plain language, tonight's boundary
 * with overrides folded in, today's screen time, one tripwire banner not
 * eight, and the 15/30/60 grant buttons right here because this is the page
 * open when the child asks".
 *
 * Above the cards, in homework's shape: a one-line summary per child, then
 * "Needs you" — shown only when something does.
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
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState<Record<string, PendingGrant>>({});

  const refresh = useCallback(async () => {
    try {
      const body = await getToday();
      setCards(body.devices);
      setGeneratedAt(body.generated_at);
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

  // Keep "Applied ✓" on screen for a while once the Mac confirms, then let
  // the page settle instead of polling at 5 s for ever. See `settlePending`.
  useEffect(() => {
    if (!cards) return;
    setPending((current) => settlePending(current, cards, Date.now()));
  }, [cards]);

  const attention = useMemo(() => needsYou(cards ?? []), [cards]);

  return (
    <Page
      title="Today"
      actions={
        <>
          {generatedAt ? (
            <span className="text-[13px] text-muted-foreground">
              Updated {new Date(generatedAt).toLocaleTimeString()}
            </span>
          ) : null}
          <Link
            href="/override"
            className="text-[13px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            Extra time history
          </Link>
        </>
      }
    >
      {error ? <ErrorNote error={error} /> : null}
      {cards === null && !error ? <Spinner /> : null}

      {cards !== null && cards.length === 0 ? (
        <Banner tone="info" title="No Macs yet">
          <Link href="/setup" className="underline">
            Add one
          </Link>{" "}
          to start.
        </Banner>
      ) : null}

      {cards && cards.length > 0 ? <ChildSummary cards={cards} /> : null}

      {attention.length > 0 ? (
        <section aria-label="Needs you" className="space-y-2">
          <h2 className="font-heading text-lg font-medium tracking-tight">Needs you</h2>
          {attention.map((item) => (
            <Link key={item.key} href={item.href} className="block">
              <Banner tone={item.tone} title={item.title}>
                {item.detail}
              </Banner>
            </Link>
          ))}
        </section>
      ) : null}

      <div className="space-y-4">
        {cards?.map((card) => (
          <HealthCard key={card.device_id} card={card}>
            {/* Extra time for a Mac that has never enrolled changes nothing
                it will ever see; its card says how to finish setting it up. */}
            {card.health.state === "UNENROLLED" ? null : (
              <GrantButtons
                card={card}
                pending={pending[card.device_id] ?? null}
                onGranted={(grant) => {
                  setPending((current) => ({ ...current, [card.device_id]: grant }));
                  void refresh();
                }}
                onError={setError}
              />
            )}
          </HealthCard>
        ))}
      </div>
    </Page>
  );
}

/**
 * One row per child — homework's status hero.
 *
 * ⚠️ Says only "all clear" or how many Macs need you. It never restates
 * whether a Mac is enforcing: those sentences belong to `healthPhrasing` and
 * appear on the cards below, where each one is true of exactly one device.
 */
function ChildSummary({ cards }: { cards: DeviceCard[] }) {
  const byChild = new Map<string, DeviceCard[]>();
  for (const card of cards) {
    const key = card.child?.display_name ?? "Unassigned";
    byChild.set(key, [...(byChild.get(key) ?? []), card]);
  }
  return (
    <div className="space-y-px overflow-hidden rounded-xl shadow-[0_2px_8px_rgba(0,0,0,0.04)]">
      {[...byChild.entries()].map(([child, macs]) => {
        const troubled = macs.filter(needsAttention).length;
        const reporting = macs.filter(
          (mac) => mac.health.state === "HEALTHY" || mac.health.state === "DEGRADED",
        );
        const active = reporting.reduce((sum, mac) => sum + mac.usage_today.active_s, 0);
        const bedtime = macs
          .map((mac) => mac.tonight?.windows[0]?.restricted_from)
          .find((value): value is string => Boolean(value));
        const ok = troubled === 0;
        return (
          <div key={child} className={`px-4 py-3 ${ok ? "bg-ok/[0.07]" : "bg-attention/[0.1]"}`}>
            <div className="flex items-start gap-3">
              {ok ? (
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-ok" />
              ) : (
                <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-attention" />
              )}
              <div className="min-w-0">
                <p className="font-heading text-lg font-medium leading-tight">
                  {child}:{" "}
                  {ok
                    ? "all clear"
                    : troubled === 1
                      ? "1 Mac needs you"
                      : `${troubled} Macs need you`}
                </p>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  {[
                    bedtime ? `Bedtime ${bedtime}` : "No bedtime set",
                    reporting.length > 0 ? `${humanMinutes(active)} active today` : null,
                    macs.length === 1 ? "1 Mac" : `${macs.length} Macs`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function needsAttention(card: DeviceCard): boolean {
  return card.shadow_mode || card.health.state !== "HEALTHY" || card.banner !== null;
}

interface AttentionItem {
  key: string;
  href: string;
  tone: Tone;
  title: string;
  detail?: string;
}

/**
 * Everything that needs a person, one line each, pointing at where to act.
 * Every sentence about a Mac's health comes from the same helper the card
 * uses, so the two can never disagree.
 */
function needsYou(cards: DeviceCard[]): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const card of cards) {
    const href = `/devices/${card.device_id}`;
    if (card.shadow_mode) {
      items.push({
        key: `${card.device_id}:shadow`,
        href,
        tone: "alarm",
        title: shadowModeNotEnforcing(cardSubject(card)),
      });
    }
    if (card.health.state !== "HEALTHY") {
      const phrasing = cardPhrasing(card);
      items.push({
        key: `${card.device_id}:health`,
        // A Mac that never enrolled is fixed where codes are issued.
        href: card.health.state === "UNENROLLED" ? "/setup" : href,
        tone: phrasing.tone as Tone,
        title: phrasing.headline,
        detail: phrasing.reassurance ?? undefined,
      });
    }
    if (card.banner) {
      items.push({
        key: `${card.device_id}:banner`,
        href,
        tone: card.banner.severity as Tone,
        title: `${card.label ?? "A Mac"}: ${card.banner.summary}`,
      });
    }
  }
  return items;
}
