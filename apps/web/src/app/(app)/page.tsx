"use client";

import { shadowModeNotEnforcing } from "@hpc/contract";
import { CheckCircle2, CircleAlert } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { GrantButtons, type PendingGrant } from "../../components/grant-buttons.js";
import { cardPhrasing, cardSubject, HealthCard } from "../../components/health-card.js";
import { HistoryList } from "../../components/history-list.js";
import { Page } from "../../components/shell/page.js";
import { useViewing } from "../../components/shell/viewing.js";
import { Banner, ErrorNote, Spinner, type Tone } from "../../components/ui.js";
import { humanMinutes } from "../../lib/format.js";
import { settlePending } from "../../lib/grant-progress.js";
import { type DeviceCard, getReports, getToday, type HistoryItem } from "../../lib/parent-api.js";
import { needsAttention } from "../../lib/selected-child.js";

/**
 * `/` — Today.
 *
 * §5.8: "one card per device, health in plain language, tonight's boundary
 * with overrides folded in, today's screen time, one tripwire banner not
 * eight, and the 15/30/60 grant buttons right here because this is the page
 * open when the child asks".
 *
 * About ONE child — the one picked in the sidebar's Viewing switch. Above
 * the cards, in homework's shape: a one-line summary, then "Needs you" —
 * shown only when something does. Another child's trouble is marked in the
 * switch itself, so scoping this page never hides it.
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

/**
 * ★ What needs a look: the red rows of the last 7 days (2026-10-04, owner's
 * call), from the same history Activity shows — not the tripwire banners,
 * which said "no longer syncing its clock" long after it was fixed.
 *
 * Its own slow refresh: a 7-day history read is heavier than the 30 s Today
 * poll should carry, and nothing in it is urgent to the second.
 */
const FLAGGED_DAYS = 7;
const FLAGGED_POLL_MS = 5 * 60_000;

export default function TodayPage() {
  const viewing = useViewing();
  const [allCards, setCards] = useState<DeviceCard[] | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState<Record<string, PendingGrant>>({});

  const { noteToday } = viewing;
  const refresh = useCallback(async () => {
    try {
      const body = await getToday();
      setCards(body.devices);
      noteToday(body.devices);
      setGeneratedAt(body.generated_at);
      setError(null);
    } catch (caught) {
      setError(caught);
    }
  }, [noteToday]);

  const watching = Object.keys(pending).length > 0;

  useEffect(() => {
    void refresh();
    const interval = setInterval(refresh, watching ? WATCHING_POLL_MS : IDLE_POLL_MS);
    return () => clearInterval(interval);
  }, [refresh, watching]);

  // Keep "Applied ✓" on screen for a while once the Mac confirms, then let
  // the page settle instead of polling at 5 s for ever. See `settlePending`.
  // Over EVERY device, not just this child's: a grant still in flight when
  // the parent switches child must not keep the page on the fast poll.
  useEffect(() => {
    if (!allCards) return;
    setPending((current) => settlePending(current, allCards, Date.now()));
  }, [allCards]);

  const childId = viewing.child?.id ?? null;
  const [flagged, setFlagged] = useState<HistoryItem[] | null>(null);
  const loadFlagged = useCallback(async () => {
    // Never unscoped — the same rule as Activity: one child's page.
    if (!childId) return;
    try {
      const now = new Date();
      const report = await getReports({
        grain: "hour",
        child_id: childId,
        from: new Date(now.getTime() - FLAGGED_DAYS * 86_400_000).toISOString(),
        to: now.toISOString(),
      });
      setFlagged(report.enforcement.filter((row) => row.tone === "alarm"));
    } catch (caught) {
      setError(caught);
    }
  }, [childId]);

  useEffect(() => {
    setFlagged(null);
    void loadFlagged();
    const interval = setInterval(loadFlagged, FLAGGED_POLL_MS);
    return () => clearInterval(interval);
  }, [loadFlagged]);

  const cards = useMemo(
    () => allCards?.filter((card) => card.child?.id === childId) ?? null,
    [allCards, childId],
  );
  const attention = useMemo(() => needsYou(cards ?? []), [cards]);
  const ready = cards !== null && viewing.children !== null;

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
      {!ready && !error ? <Spinner /> : null}

      {ready && !viewing.child ? (
        <Banner tone="info" title="No children yet">
          Add a child and their device in{" "}
          <Link href="/settings/children" className="underline">
            Settings › Children &amp; devices
          </Link>
          .
        </Banner>
      ) : null}

      {ready && viewing.child && cards.length === 0 ? (
        <Banner tone="info" title={`No devices for ${viewing.child.displayName} yet`}>
          Add one in{" "}
          <Link href="/settings/children" className="underline">
            Settings › Children &amp; devices
          </Link>
          .
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

      {ready && viewing.child && cards.length > 0 ? (
        <section aria-label="Flagged" className="space-y-1">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="font-heading text-lg font-medium tracking-tight">
              Flagged — last {FLAGGED_DAYS} days
            </h2>
            <Link
              href="/reports"
              className="text-[13px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Activity
            </Link>
          </div>
          {flagged === null ? (
            <Spinner />
          ) : (
            <HistoryList
              rows={flagged}
              limit={20}
              empty={`Nothing flagged in the last ${FLAGGED_DAYS} days.`}
            />
          )}
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
 * One row per child — homework's status hero. With the page scoped to one
 * child that is one row, but the grouping stays: a device with no child
 * still lands somewhere sensible.
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
        href: card.health.state === "UNENROLLED" ? "/settings/children" : href,
        tone: phrasing.tone as Tone,
        title: phrasing.headline,
        detail: phrasing.reassurance ?? undefined,
      });
    }
  }
  return items;
}
