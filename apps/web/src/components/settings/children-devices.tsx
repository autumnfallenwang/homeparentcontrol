"use client";

import { ChevronRight, Plus } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  createChild,
  createDevice,
  type DeviceCard,
  getSetup,
  getToday,
  reissueCode,
} from "../../lib/parent-api.js";
import { stateLabel } from "../../lib/state-label.js";
import { DeviceDangerZone } from "../device-danger-zone.js";
import { cardPhrasing } from "../health-card.js";
import { Page, SectionTitle } from "../shell/page.js";
import { useViewing } from "../shell/viewing.js";
import {
  Badge,
  Banner,
  Button,
  Card,
  ErrorNote,
  Field,
  inputClass,
  Spinner,
  type Tone,
} from "../ui.js";

/**
 * Settings › Children & devices — who is in the household, and the devices
 * that enforce their bedtime. Everything that used to be "Add a Mac" and the
 * Macs list, plus ending a device's enrolment.
 *
 * "Devices", not "Macs": the agent is macOS-only today, and the household
 * model is not — a second platform should not mean renaming this tab.
 *
 * ⚠️ **The code is shown once.** The server stores a SHA-256 and a
 * four-character hint, so "which code was that?" is answerable and "what was
 * the code?" is not. The page says so, because a parent who assumes they can
 * come back for it will close this tab.
 */

type Setup = Awaited<ReturnType<typeof getSetup>>;
type SetupDevice = Setup["devices"][number];

interface FreshCode {
  label: string;
  code: string;
  expires_at: string;
}

export function ChildrenAndDevices() {
  const viewing = useViewing();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [cards, setCards] = useState<DeviceCard[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [freshCode, setFreshCode] = useState<FreshCode | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [nextSetup, today] = await Promise.all([getSetup(), getToday()]);
      setSetup(nextSetup);
      setCards(today.devices);
      setError(null);
    } catch (caught) {
      setError(caught);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** After any change: this page, and the Viewing switch in the sidebar. */
  const changed = useCallback(async () => {
    await Promise.all([refresh(), viewing.refresh()]);
  }, [refresh, viewing.refresh]);

  async function run(step: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await step();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  const title = "Children & devices";
  if (!setup) {
    return <Page title={title}>{error ? <ErrorNote error={error} /> : <Spinner />}</Page>;
  }

  const live = setup.devices.filter((device) => device.status !== "decommissioned");
  const unassigned = live.filter(
    (device) => !setup.children.some((child) => child.id === device.childId),
  );
  const retired = setup.devices.length - live.length;

  const deviceRow = (device: SetupDevice) => (
    <DeviceRow
      key={device.id}
      device={device}
      card={cards.find((card) => card.device_id === device.id)}
      pending={setup.pending_codes.find((row) => row.device_id === device.id)}
      busy={busy}
      onNewCode={() =>
        run(async () => {
          const issued = await reissueCode(device.id);
          setFreshCode({ label: device.label ?? "the Mac", ...issued });
          await changed();
        })
      }
      onChanged={() => void changed()}
    />
  );

  return (
    <Page title={title} subtitle="Who is in the household, and the devices that enforce bedtime.">
      {error ? <ErrorNote error={error} /> : null}

      {freshCode ? (
        <Banner tone="ok" title={`Type this into the installer on ${freshCode.label}`}>
          <p className="my-2 select-all font-mono text-2xl tracking-wider text-foreground">
            {freshCode.code}
          </p>
          {/* ★ Once. Nothing stores it. */}
          <p>
            This is the only time it is shown — nothing stores it. It expires{" "}
            {new Date(freshCode.expires_at).toLocaleTimeString()}.
          </p>
        </Banner>
      ) : null}

      {setup.children.length === 0 ? (
        <Banner tone="info" title="No children yet">
          Add a child below, then a device for them.
        </Banner>
      ) : null}

      {setup.children.map((child) => (
        <ChildCard
          key={child.id}
          name={child.displayName}
          busy={busy}
          onAddDevice={(label) =>
            run(async () => {
              const created = await createDevice({ child_id: child.id, label });
              setFreshCode({ label, code: created.code, expires_at: created.expires_at });
              await changed();
            })
          }
        >
          {live.filter((device) => device.childId === child.id).map(deviceRow)}
        </ChildCard>
      ))}

      {unassigned.length > 0 ? (
        <Card>
          <SectionTitle>Not assigned to a child</SectionTitle>
          <ul className="mt-2 divide-y divide-border">{unassigned.map(deviceRow)}</ul>
        </Card>
      ) : null}

      <AddChild
        busy={busy}
        onAdd={(name) =>
          run(async () => {
            await createChild({ display_name: name });
            await changed();
          })
        }
      />

      {/* ⚠️ A live device cannot be handed a fresh code — that would let a
          second machine take over its identity while the first kept
          enforcing with a credential nobody knows about. */}
      <p className="text-xs text-muted-foreground">
        A device that has already enrolled cannot be given a new code.
        {retired > 0
          ? ` ${retired} decommissioned ${retired === 1 ? "device is" : "devices are"} not shown; their history is kept.`
          : ""}
      </p>
    </Page>
  );
}

function ChildCard({
  name,
  busy,
  onAddDevice,
  children,
}: {
  name: string;
  busy: boolean;
  onAddDevice: (label: string) => Promise<void>;
  children: React.ReactNode[];
}) {
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  return (
    <Card>
      <div className="flex items-baseline justify-between gap-3">
        <SectionTitle>{name}</SectionTitle>
        <span className="text-[13px] text-muted-foreground">
          {children.length === 1 ? "1 device" : `${children.length} devices`}
        </span>
      </div>
      {children.length > 0 ? (
        <ul className="mt-2 divide-y divide-border">{children}</ul>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">No devices yet.</p>
      )}
      <div className="mt-3">
        {adding ? (
          <div className="space-y-2 rounded-lg border border-border bg-secondary/40 p-3">
            <div className="flex flex-wrap items-end gap-2">
              <Field label="What to call it">
                <input
                  className={inputClass}
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder={`${name}'s MacBook`}
                />
              </Field>
              <Button
                variant="primary"
                disabled={!label.trim() || busy}
                onClick={async () => {
                  await onAddDevice(label.trim());
                  setLabel("");
                  setAdding(false);
                }}
              >
                Add it and get a code
              </Button>
              <Button variant="quiet" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Only Macs are supported for now.</p>
          </div>
        ) : (
          <Button onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" />
            Add a device for {name}
          </Button>
        )}
      </div>
    </Card>
  );
}

function DeviceRow({
  device,
  card,
  pending,
  busy,
  onNewCode,
  onChanged,
}: {
  device: SetupDevice;
  card: DeviceCard | undefined;
  pending: Setup["pending_codes"][number] | undefined;
  busy: boolean;
  onNewCode: () => void;
  onChanged: () => void;
}) {
  const status = statusOf(device, card);
  const enrolled = device.status !== "pending";
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-foreground">{device.label ?? "Unnamed device"}</span>
        <Badge tone={status.tone}>{status.label}</Badge>
        {card?.agent_version ? (
          <span className="text-[13px] text-muted-foreground">agent {card.agent_version}</span>
        ) : null}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {pending ? (
            <span className="text-[13px] text-muted-foreground">
              code {pending.hint}…{pending.expired ? " (expired)" : ""}
            </span>
          ) : null}
          {enrolled ? (
            <Link
              href={`/devices/${device.id}`}
              className="inline-flex min-h-11 items-center gap-0.5 text-[13px] text-muted-foreground hover:text-foreground"
            >
              Details <ChevronRight className="h-4 w-4" />
            </Link>
          ) : (
            <Button variant="quiet" disabled={busy} onClick={onNewCode}>
              New code
            </Button>
          )}
        </span>
      </div>
      {enrolled ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-[13px] text-muted-foreground hover:text-foreground">
            Manage — revoke or decommission
          </summary>
          <div className="mt-2">
            <DeviceDangerZone deviceId={device.id} onChanged={onChanged} />
          </div>
        </details>
      ) : null}
    </li>
  );
}

/**
 * The badge. For an enrolled device it is the contract's own tone and a
 * short state label — never a second phrasing of health.
 */
function statusOf(
  device: SetupDevice,
  card: DeviceCard | undefined,
): { tone: Tone; label: string } {
  if (device.status === "pending") return { tone: "warn", label: "not set up yet" };
  if (device.status === "revoked") return { tone: "alarm", label: "revoked" };
  if (!card) return { tone: "plain", label: device.status };
  if (card.shadow_mode) return { tone: "alarm", label: "not enforcing (soak)" };
  return { tone: cardPhrasing(card).tone as Tone, label: stateLabel(card.health.state) };
}

function AddChild({ busy, onAdd }: { busy: boolean; onAdd: (name: string) => Promise<void> }) {
  const [name, setName] = useState("");
  return (
    <Card>
      <SectionTitle>Add a child</SectionTitle>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <Field label="Name">
          <input
            className={inputClass}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Lucy"
          />
        </Field>
        <Button
          disabled={!name.trim() || busy}
          onClick={async () => {
            await onAdd(name.trim());
            setName("");
          }}
        >
          Add child
        </Button>
      </div>
    </Card>
  );
}
