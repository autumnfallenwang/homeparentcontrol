"use client";

import { LATE_GRANT_DOES_NOT_UNLOCK, SUSPEND_IS_NOT_OFF } from "@hpc/contract";
import { useState } from "react";
import { humanDuration } from "../lib/format.js";
import { type DeviceCard, type GrantResult, grantOverride } from "../lib/parent-api.js";
import { Banner, Button } from "./ui.js";

/**
 * The 15/30/60 buttons, and the two-stage state behind them.
 *
 * §5.8 puts these on `/` "because this is the page open when the child asks".
 *
 * ★ **"Applied" is driven by the agent's own next tick**, never by the
 * server's write. §5.8: claiming success on the write is the *"the server
 * thinks it delivered"* failure mode that polling was chosen to avoid. The
 * parent sees `Sent ✓` immediately and `Applied ✓` only once the device
 * reports the new `policy_version`.
 */

export const QUICK_MINUTES = [15, 30, 60] as const;

/** §5.8: "If it has not landed in 30 s: `Sent ✓ — not yet applied`". */
export const APPLIED_DEADLINE_MS = 30_000;

export interface PendingGrant {
  deviceId: string;
  result: GrantResult;
  sentAt: number;
}

export function GrantButtons({
  card,
  pending,
  onGranted,
  onError,
}: {
  card: DeviceCard;
  pending: PendingGrant | null;
  onGranted: (grant: PendingGrant) => void;
  onError: (error: unknown) => void;
}) {
  const [busy, setBusy] = useState<number | "suspend" | null>(null);
  const offline =
    card.health.state === "UNEXPECTED_SILENCE" || card.health.state === "SILENT_TOO_LONG";

  async function grant(minutes: number | "suspend") {
    setBusy(minutes);
    try {
      const result = await grantOverride(
        minutes === "suspend"
          ? { device_id: card.device_id, type: "suspend" }
          : { device_id: card.device_id, type: "extend", minutes },
      );
      onGranted({ deviceId: card.device_id, result, sentAt: Date.now() });
    } catch (error) {
      onError(error);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {QUICK_MINUTES.map((minutes) => (
          <Button
            key={minutes}
            onClick={() => grant(minutes)}
            disabled={busy !== null || card.status === "decommissioned"}
          >
            +{minutes} min
          </Button>
        ))}
        <Button
          variant="quiet"
          onClick={() => grant("suspend")}
          disabled={busy !== null || card.status === "decommissioned"}
        >
          {/* ⚠️ "No bedtime tonight", never "off". It still expires. */}
          {SUSPEND_IS_NOT_OFF}
        </Button>
      </div>

      {pending ? <GrantProgress card={card} pending={pending} /> : null}

      {/*
        ★ The §3.5 sentence. Shown when enforcement has ALREADY fired, which
        is exactly when a parent is most likely to believe a grant reopens
        the machine. Nothing third-party can draw over the macOS lock screen.
      */}
      {card.last_enforcement?.is_locked_now ? (
        <Banner tone="info" title="A grant now won't unlock the Mac">
          {LATE_GRANT_DOES_NOT_UNLOCK}
        </Banner>
      ) : null}

      {offline ? (
        <Banner tone="warn" title="This Mac isn't checking in">
          {/* ⚠️ D.5 — the sentence ends here. There is no code to read out. */}
          {`${card.label ?? "This Mac"} hasn't checked in for ${humanDuration(
            card.health.silent_for_s,
          )}. A grant will apply when it reconnects.`}
        </Banner>
      ) : null}
    </div>
  );
}

/**
 * ★ Two-stage, and the second stage is the AGENT's word.
 *
 * ```
 * +30 min for Lucy   Sent ✓ 21:29:58  →  Applied ✓ 21:30:03  (5 s)
 * ```
 */
function GrantProgress({ card, pending }: { card: DeviceCard; pending: PendingGrant }) {
  const target = pending.result.awaiting_policy_version;
  const applied =
    target !== null &&
    card.health.applied_policy_version !== null &&
    card.health.applied_policy_version >= target;

  const elapsedMs = Date.now() - pending.sentAt;
  const sentAt = new Date(pending.result.sent_at).toLocaleTimeString();

  if (applied) {
    return (
      <Banner tone="ok" title={`Applied ✓ — the Mac has the new rules`}>
        {`Sent ${sentAt} · applied after about ${Math.max(1, Math.round(elapsedMs / 1000))} s. ` +
          `Expires ${new Date(pending.result.expires_at).toLocaleString()}.`}
      </Banner>
    );
  }

  // §5.8's 30-second rule: after that, say so, and show the health.
  if (elapsedMs > APPLIED_DEADLINE_MS) {
    return (
      <Banner tone="warn" title="Sent ✓ — not yet applied">
        {`The Mac last checked in ${humanDuration(card.health.silent_for_s)} ago. ` +
          "It will pick this up on its next check-in."}
      </Banner>
    );
  }

  return (
    <Banner tone="info" title={`Sent ✓ ${sentAt}`}>
      Waiting for the Mac to confirm…
    </Banner>
  );
}
