"use client";

import { ChevronRight, Plus } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { cardPhrasing } from "../../../components/health-card.js";
import { Page } from "../../../components/shell/page.js";
import { Badge, Banner, Card, ErrorNote, Spinner, type Tone } from "../../../components/ui.js";
import {
  type DeviceCard,
  type DeviceSummary,
  getToday,
  listDevices,
} from "../../../lib/parent-api.js";
import { stateLabel } from "../../../lib/state-label.js";

/**
 * `/devices` — every Mac, including the ones that never enrolled.
 *
 * Today shows enrolled Macs only. A Mac whose code expired used to exist
 * nowhere in the UI except as a `pending` row in Setup; here it is listed
 * with the way to fix it.
 */
export default function MacsPage() {
  const [devices, setDevices] = useState<DeviceSummary[] | null>(null);
  const [cards, setCards] = useState<Map<string, DeviceCard>>(new Map());
  const [error, setError] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    try {
      const [list, today] = await Promise.all([listDevices(), getToday()]);
      setDevices(list.devices);
      setCards(new Map(today.devices.map((card) => [card.device_id, card])));
      setError(null);
    } catch (caught) {
      setError(caught);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <Page
      title="Macs"
      actions={
        <Link
          href="/setup"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-primary bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          Add a Mac
        </Link>
      }
    >
      {error ? <ErrorNote error={error} /> : null}
      {devices === null && !error ? <Spinner /> : null}
      {devices?.length === 0 ? (
        <Banner tone="info" title="No Macs yet">
          Add one to start — it takes about five minutes on the Mac itself.
        </Banner>
      ) : null}

      {devices?.map((device) => {
        const card = cards.get(device.id);
        const status = statusOf(device, card);
        const pending = device.status === "pending";
        return (
          <Link
            key={device.id}
            href={pending ? "/setup" : `/devices/${device.id}`}
            className="block"
          >
            <Card>
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-heading text-lg font-medium tracking-tight">
                      {device.label ?? "Unnamed Mac"}
                    </h2>
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </div>
                  <p className="mt-1 text-[13px] text-muted-foreground">
                    {[
                      card?.child?.display_name,
                      card?.agent_version ? `agent ${card.agent_version}` : null,
                      pending ? "Get a new code in Add a Mac" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </div>
            </Card>
          </Link>
        );
      })}
    </Page>
  );
}

/**
 * The badge. For an enrolled Mac it is the contract's own tone and headline —
 * never a second phrasing of health.
 */
function statusOf(
  device: DeviceSummary,
  card: DeviceCard | undefined,
): { tone: Tone; label: string } {
  if (device.status === "pending") return { tone: "warn", label: "never enrolled" };
  if (device.status === "revoked") return { tone: "alarm", label: "revoked" };
  if (!card) return { tone: "plain", label: device.status };
  if (card.shadow_mode) return { tone: "alarm", label: "not enforcing (soak)" };
  const phrasing = cardPhrasing(card);
  return { tone: phrasing.tone as Tone, label: stateLabel(card.health.state) };
}
