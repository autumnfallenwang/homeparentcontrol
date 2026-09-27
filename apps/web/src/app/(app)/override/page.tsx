"use client";

import { useCallback, useEffect, useState } from "react";
import { GrantButtons, type PendingGrant } from "../../../components/grant-buttons.js";
import { Page } from "../../../components/shell/page.js";
import { Button, Card, ErrorNote, Spinner } from "../../../components/ui.js";
import { dayAndTime } from "../../../lib/format.js";
import {
  type DeviceCard,
  getToday,
  listOverrides,
  revokeOverride,
} from "../../../lib/parent-api.js";

/**
 * `/override` — the grant history, and the same two-stage state as `/`.
 *
 * ★ §5.8: "**'Applied' is driven by the agent's own next tick** reporting the
 * new `policy_version` and a shifted `next_boundary_at` — **never by the
 * server's own write.** Claiming success on the write is the *'the server
 * thinks it delivered'* failure mode that polling was chosen to avoid."
 */
export default function OverridePage() {
  const [cards, setCards] = useState<DeviceCard[] | null>(null);
  const [history, setHistory] = useState<Awaited<ReturnType<typeof listOverrides>> | null>(null);
  const [pending, setPending] = useState<Record<string, PendingGrant>>({});
  const [error, setError] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    try {
      const [today, overrides] = await Promise.all([getToday(), listOverrides()]);
      setCards(today.devices);
      setHistory(overrides);
      setError(null);
    } catch (caught) {
      setError(caught);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(refresh, Object.keys(pending).length > 0 ? 5_000 : 30_000);
    return () => clearInterval(interval);
  }, [refresh, pending]);

  return (
    <Page title="Extra time" back={{ href: "/", label: "Today" }}>
      {error ? (
        <div className="mb-4">
          <ErrorNote error={error} />
        </div>
      ) : null}
      {!cards ? <Spinner /> : null}

      <div className="space-y-4">
        {cards?.map((card) => (
          <Card key={card.device_id}>
            <h2 className="font-heading text-lg font-medium tracking-tight">
              {card.child?.display_name ?? "Unknown"} · {card.label}
            </h2>
            <div className="mt-3">
              <GrantButtons
                card={card}
                pending={pending[card.device_id] ?? null}
                onGranted={(grant) => {
                  setPending((current) => ({ ...current, [card.device_id]: grant }));
                  void refresh();
                }}
                onError={setError}
              />
            </div>
          </Card>
        ))}

        {history ? (
          <Card>
            <h2 className="font-heading text-lg font-medium tracking-tight">Recent grants</h2>
            {history.overrides.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">None yet.</p>
            ) : (
              <ul className="mt-3 space-y-2 text-sm">
                {history.overrides.map((row) => (
                  <li key={row.id} className="flex flex-wrap items-center gap-3">
                    <span className="w-40 shrink-0 text-muted-foreground">
                      {dayAndTime(row.created_at)}
                    </span>
                    <span className="text-foreground">
                      {row.type === "suspend" ? "No bedtime" : `+${row.minutes} min`}
                    </span>
                    <span className="text-muted-foreground">
                      {row.revoked_at
                        ? "revoked"
                        : row.live
                          ? `expires ${dayAndTime(row.expires_at)}`
                          : "expired"}
                    </span>
                    {row.live ? (
                      <Button
                        variant="quiet"
                        onClick={async () => {
                          await revokeOverride(row.id);
                          void refresh();
                        }}
                      >
                        Take it back
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {/* ⚠️ Revoked rows stay. "She got an extra 30 minutes on Tuesday
                and I took it back" is a fact worth keeping. */}
            <p className="mt-3 text-xs text-muted-foreground">
              Grants are never deleted — a revoked one stays here so the history is complete.
            </p>
          </Card>
        ) : null}
      </div>
    </Page>
  );
}
