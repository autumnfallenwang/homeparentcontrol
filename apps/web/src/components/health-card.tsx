"use client";

import {
  ACTIVE_TIME_EXPLANATION,
  ACTIVE_TIME_LABEL,
  healthPhrasing,
  shadowModeNotEnforcing,
} from "@hpc/contract";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { appName, humanDuration, humanMinutes, weekdayOf } from "../lib/format.js";
import type { DeviceCard } from "../lib/parent-api.js";
import { Banner, Card, NoData, type Tone } from "./ui.js";

/**
 * One card per device — the whole of `/` for one Mac.
 *
 * ⚠️ Every sentence about health comes from `healthPhrasing` in
 * `@hpc/contract`, never from a string written here. See that module's header
 * for why: the natural phrasing of each state says something false, and a
 * second copy of the wording in the UI is a copy that will drift.
 */
/** Who the sentences are about. */
export function cardSubject(card: DeviceCard) {
  return {
    childName: card.child?.display_name ?? "your child",
    deviceLabel: card.label ?? "This Mac",
  };
}

/**
 * The contract's words for this card's health — the ONLY source of them.
 * Exported so Today's "needs you" rows say exactly what the card says.
 */
export function cardPhrasing(card: DeviceCard) {
  // ★ `lastPolicyDay` is the day the RULES came from, not the day it last
  // synced. §4.6's sentence is about which rules are in force.
  return healthPhrasing(card.health.state, cardSubject(card), {
    silentFor: humanDuration(card.health.silent_for_s),
    lastPolicyDay: weekdayOf(card.health.applied_policy_at),
  });
}

export function HealthCard({ card, children }: { card: DeviceCard; children?: React.ReactNode }) {
  const subject = cardSubject(card);
  const phrasing = cardPhrasing(card);

  const usage = card.usage_today;
  const reporting = card.health.state === "HEALTHY" || card.health.state === "DEGRADED";

  return (
    <Card tone={phrasing.tone as Tone}>
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-heading text-xl font-medium tracking-tight">
          <Link href={`/devices/${card.device_id}`} className="hover:underline">
            {card.label ?? "Unnamed Mac"}
          </Link>
        </h2>
        {/* The child's name is the page's own context now (Viewing), so the
            corner carries the way into this device's page instead. */}
        <Link
          href={`/devices/${card.device_id}`}
          className="inline-flex items-center gap-0.5 text-sm text-muted-foreground hover:text-foreground"
        >
          Details <ChevronRight className="h-4 w-4" />
        </Link>
      </header>

      {/*
        ★ §6.5 — shadow mode is DELIBERATE non-enforcement, and it goes above
        the health line because it overrides it: a device can be perfectly
        HEALTHY and still not be enforcing tonight. Intended or not, the
        parent has to be told in those words.
      */}
      {card.shadow_mode ? (
        <div className="mt-3">
          <Banner tone="alarm" title={shadowModeNotEnforcing(subject)} />
        </div>
      ) : null}

      <p className="mt-2 text-sm font-medium text-foreground">{phrasing.headline}</p>
      {/* ★ The still-enforcing sentence. Absent only for DEGRADED, where it
          would be a lie. */}
      {phrasing.reassurance ? (
        <p className="mt-1 text-sm text-foreground/85">{phrasing.reassurance}</p>
      ) : null}

      {/* ★ ONE banner, and a count for the rest. */}
      {card.banner ? (
        <div className="mt-3">
          <Banner tone={card.banner.severity} title={card.banner.summary}>
            {card.banner.benign ? <p>{card.banner.benign}</p> : null}
            {card.banner.also_open > 0 ? (
              <p className="mt-1 text-xs opacity-75">
                <Link href={`/devices/${card.device_id}`} className="underline">
                  {card.banner.also_open === 1
                    ? "and 1 other"
                    : `and ${card.banner.also_open} others`}
                </Link>
              </p>
            ) : null}
          </Banner>
        </div>
      ) : null}

      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-muted-foreground">Tonight</dt>
          <dd className="font-medium text-foreground">{tonightLine(card)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground" title={ACTIVE_TIME_EXPLANATION}>
            {ACTIVE_TIME_LABEL}
          </dt>
          <dd className="font-medium text-foreground">
            {/*
              ★ §5.7 — zero usage and no data mean opposite things. A device
              that is not reporting gets a dash and a reason, never a 0.
            */}
            {reporting ? humanMinutes(usage.active_s) : <NoData>no data today</NoData>}
          </dd>
        </div>
      </dl>
      {/* The label's explanation, visible rather than only a tooltip — a
          tooltip does not exist on the phone this is read on. */}
      <p className="mt-1 text-xs text-muted-foreground">{ACTIVE_TIME_EXPLANATION}</p>

      {reporting && usage.top_apps.length > 0 ? (
        <ul className="mt-3 space-y-1 text-sm">
          {usage.top_apps.map((app) => (
            <li key={app.bundle_id} className="flex justify-between gap-3">
              <span className="truncate text-foreground/85">{appName(app.bundle_id)}</span>
              <span className="tabular-nums text-muted-foreground">
                {humanMinutes(app.active_s)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {card.active_grants.length > 0 ? (
        <p className="mt-3 text-sm text-foreground/85">
          {card.active_grants
            .map((grant) =>
              grant.type === "suspend" ? "No bedtime tonight" : `+${grant.minutes} min tonight`,
            )
            .join(" · ")}
        </p>
      ) : null}

      {children ? <div className="mt-4 border-t border-border pt-4">{children}</div> : null}
    </Card>
  );
}

function tonightLine(card: DeviceCard): string {
  const window = card.tonight?.windows[0];
  if (!window?.restricted_from) return "No bedtime set";
  const suspended = card.active_grants.some((grant) => grant.type === "suspend");
  if (suspended) return "No bedtime tonight";
  const extended = card.active_grants.find((grant) => grant.type === "extend");
  if (extended?.minutes) {
    return `${window.restricted_from} → ${shift(window.restricted_from, extended.minutes)}`;
  }
  return window.restricted_from;
}

function shift(hhmm: string, minutes: number): string {
  const [hours = "0", mins = "0"] = hhmm.split(":");
  const total = (Number(hours) * 60 + Number(mins) + minutes) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
