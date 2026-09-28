"use client";

import { REMOVE_DEVICE } from "@hpc/contract";
import { Check, ChevronRight, Copy, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { apiBaseUrl } from "../../lib/api.js";
import { copyText } from "../../lib/clipboard.js";
import { installCommand } from "../../lib/install-command.js";
import {
  createChild,
  createDevice,
  type DeviceCard,
  getSetup,
  getToday,
  reissueCode,
  removeDevice,
} from "../../lib/parent-api.js";
import { stateLabel } from "../../lib/state-label.js";
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
  SegmentedControl,
  Spinner,
  type Tone,
} from "../ui.js";

/**
 * Settings › Children & devices — who is in the household, and the devices
 * that enforce their bedtime: add a child, add a device, set it up with its
 * code, remove it. That is the whole job, and the page does nothing else.
 *
 * "Devices", not "Macs": the agent is macOS-only today, and the household
 * model is not — a second platform should not mean renaming this tab.
 *
 * ⚠️ **The code is shown once.** The server stores a SHA-256 and a
 * four-character hint, so "which code was that?" is answerable and "what was
 * the code?" is not. The page says so, because a parent who assumes they can
 * come back for it will close this tab.
 *
 * The code sits in its device's own row, with Copy beside New code. It used
 * to be a banner at the top of the page — away from the device it belonged
 * to, and with nothing to copy it with.
 *
 * Remove is confirmed in place, the way homework removes a child: the row
 * turns into the question and what will happen. It replaced Revoke and
 * Decommission's typed-word forms (ADR 0011).
 */

type Setup = Awaited<ReturnType<typeof getSetup>>;
type SetupDevice = Setup["devices"][number];

/** A code this page just made — the only place the full code ever exists. */
interface FreshCode {
  code: string;
  expires_at: string;
}

export function ChildrenAndDevices() {
  const viewing = useViewing();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [cards, setCards] = useState<DeviceCard[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [codes, setCodes] = useState<Record<string, FreshCode>>({});
  // ⚠️ Page-level, not in the row: a removed device leaves the list on the
  // very refresh that follows, taking any in-row "done" with it — seen on the
  // first real decommission, which confirmed nothing on screen.
  const [removed, setRemoved] = useState<{ device: string; status: string } | null>(null);
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

  // While a device is waiting to be set up — or has enrolled but not yet been
  // seen checking in — keep looking: the parent is at the other Mac pasting
  // the command, and this page should reach "checking in" on its own rather
  // than after a reload nobody thinks to do.
  const waiting =
    (setup?.devices.some((device) => device.status === "pending") ?? false) ||
    cards.some(awaitingFirstCheckIn);
  useEffect(() => {
    if (!waiting) return;
    const interval = setInterval(() => void changed(), 15_000);
    return () => clearInterval(interval);
  }, [waiting, changed]);

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
      fresh={codes[device.id]}
      busy={busy}
      onNewCode={() =>
        run(async () => {
          const issued = await reissueCode(device.id);
          setCodes((current) => ({ ...current, [device.id]: issued }));
          await changed();
        })
      }
      onRemove={async () => {
        await removeDevice(device.id);
        setRemoved({ device: device.label ?? "The device", status: device.status });
        await changed();
      }}
    />
  );

  return (
    <Page title={title} subtitle="Who is in the household, and the devices that enforce bedtime.">
      {error ? <ErrorNote error={error} /> : null}

      {removed ? (
        <Banner tone="ok" title={`Removed ${removed.device}`}>
          {REMOVE_DEVICE.consequence(removed.status)}
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
              setCodes((current) => ({
                ...current,
                [created.device_id]: { code: created.code, expires_at: created.expires_at },
              }));
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

      {retired > 0 ? (
        <p className="text-xs text-muted-foreground">
          {retired} removed {retired === 1 ? "device is" : "devices are"} not shown; their history
          is kept.
        </p>
      ) : null}
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
  fresh,
  busy,
  onNewCode,
  onRemove,
}: {
  device: SetupDevice;
  card: DeviceCard | undefined;
  pending: Setup["pending_codes"][number] | undefined;
  fresh: FreshCode | undefined;
  busy: boolean;
  onNewCode: () => void;
  onRemove: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const status = statusOf(device, card);
  const enrolled = device.status !== "pending";
  const name = device.label ?? "this device";

  if (confirming) {
    return (
      <li className="py-3">
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1">
              <p className="font-medium text-foreground">{REMOVE_DEVICE.question(name)}</p>
              <p className="text-[13px] text-muted-foreground">
                {REMOVE_DEVICE.consequence(device.status)}
              </p>
            </div>
            <Button
              variant="danger"
              disabled={removing}
              onClick={async () => {
                setRemoving(true);
                setError(null);
                try {
                  // The row leaves the list on the refresh that follows.
                  await onRemove();
                } catch (caught) {
                  setError(caught);
                  setRemoving(false);
                }
              }}
            >
              {removing ? "Removing…" : REMOVE_DEVICE.label}
            </Button>
            <Button variant="quiet" disabled={removing} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
          {error ? <ErrorNote error={error} /> : null}
        </div>
      </li>
    );
  }

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-foreground">{device.label ?? "Unnamed device"}</span>
        <Badge tone={status.tone}>{status.label}</Badge>
        {card?.agent_version ? (
          <span className="text-[13px] text-muted-foreground">agent {card.agent_version}</span>
        ) : null}
        <span className="ml-auto flex items-center gap-1">
          {enrolled ? (
            <Link
              href={`/devices/${device.id}`}
              className="inline-flex min-h-11 items-center gap-0.5 px-2 text-[13px] text-muted-foreground hover:text-foreground"
            >
              Details <ChevronRight className="h-4 w-4" />
            </Link>
          ) : null}
          <Button variant="quiet" disabled={busy} onClick={() => setConfirming(true)}>
            <Trash2 className="h-4 w-4" />
            {REMOVE_DEVICE.label}
          </Button>
        </span>
      </div>
      {enrolled ? null : (
        <EnrolmentCode
          label={device.label ?? "the Mac"}
          pending={pending}
          fresh={fresh}
          busy={busy}
          onNewCode={onNewCode}
        />
      )}
    </li>
  );
}

/**
 * The code for a device that has not enrolled yet: the full code with Copy
 * while this page still holds it, otherwise only the server's hint — and
 * New code either way.
 */
function EnrolmentCode({
  label,
  pending,
  fresh,
  busy,
  onNewCode,
}: {
  label: string;
  pending: Setup["pending_codes"][number] | undefined;
  fresh: FreshCode | undefined;
  busy: boolean;
  onNewCode: () => void;
}) {
  const [copied, setCopied] = useState<"code" | "command" | "failed" | null>(null);
  const [build, setBuild] = useState<"safe" | "full">("safe");
  const expired = fresh ? new Date(fresh.expires_at) <= new Date() : Boolean(pending?.expired);
  const live = fresh && !expired ? fresh : null;
  const command = live
    ? installCommand({ apiOrigin: apiBaseUrl(), code: live.code, safe: build === "safe" })
    : null;

  const copy = async (what: "code" | "command", text: string) => {
    setCopied((await copyText(text)) ? what : "failed");
    setTimeout(() => setCopied(null), 2500);
  };

  return (
    <div className="mt-2 rounded-lg border border-border bg-secondary/40 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        {fresh ? (
          <span className="select-all font-mono text-lg tracking-wider text-foreground">
            {fresh.code}
          </span>
        ) : pending ? (
          <span className="font-mono text-sm text-muted-foreground">{pending.hint}…</span>
        ) : (
          <span className="text-sm text-muted-foreground">No code yet</span>
        )}
        {expired ? <Badge tone="warn">expired</Badge> : null}
        <span className="ml-auto flex items-center gap-2">
          {live ? (
            <Button onClick={() => copy("code", live.code)}>
              {copied === "code" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied === "code" ? "Copied" : "Copy code"}
            </Button>
          ) : null}
          <Button variant="quiet" disabled={busy} onClick={onNewCode}>
            New code
          </Button>
        </span>
      </div>
      {/* ★ Once. Nothing stores it — so say what to do when it is gone. */}
      <p className="mt-1 text-xs text-muted-foreground">
        {live
          ? `Shown only here, only now — it expires ${new Date(live.expires_at).toLocaleTimeString()}.`
          : "The full code is shown only when it is made. Get a new code to set this Mac up."}
      </p>

      {live && command ? (
        <div className="mt-3 border-t border-border pt-3 text-sm">
          <p className="font-medium text-foreground">Set up {label}</p>
          <ol className="mt-2 list-decimal space-y-3 pl-5 text-foreground/85">
            <li>
              On that Mac, turn on <span className="font-medium">Remote Login</span> — System
              Settings › General › Sharing. It is how you get back in while the screen is locked,
              and the Full build refuses to install without it.
            </li>
            <li>
              <p>
                Open Terminal in the{" "}
                <span className="font-mono text-[13px]">homeparentcontrol</span> folder (a copy of
                this project on that Mac, with Apple's command-line tools:{" "}
                <span className="font-mono text-[13px]">xcode-select --install</span>). Paste this
                and type the Mac's password when asked:
              </p>
              <div className="mt-2 max-w-md">
                <SegmentedControl
                  label="Build"
                  value={build}
                  options={[
                    { value: "safe", label: "Safe — never powers off" },
                    { value: "full", label: "Full — powers off at bedtime" },
                  ]}
                  onChange={setBuild}
                />
              </div>
              <div className="mt-2 flex flex-wrap items-start gap-2">
                <code className="min-w-0 flex-1 select-all break-all rounded-md border border-border bg-card px-3 py-2 font-mono text-[12px] text-foreground">
                  {command}
                </code>
                <Button onClick={() => copy("command", command)}>
                  {copied === "command" ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                  {copied === "command" ? "Copied" : "Copy command"}
                </Button>
              </div>
              {copied === "failed" ? (
                <p className="mt-1 text-xs text-destructive">
                  Could not copy — select the text and copy it by hand.
                </p>
              ) : null}
            </li>
            <li>
              Come back here. {label} shows <span className="font-medium">checking in</span> by
              itself within a couple of minutes.
            </li>
          </ol>
        </div>
      ) : null}
    </div>
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
  // ⚠️ Enrolled seconds ago, health not computed yet: the raw state reads
  // "unenrolled" — the opposite of what just happened. Seen on the first walk.
  if (awaitingFirstCheckIn(card)) return { tone: "info", label: "waiting for first check-in" };
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

/** Enrolled, but the server has not yet seen it check in (health lags a minute). */
function awaitingFirstCheckIn(card: DeviceCard): boolean {
  return card.status !== "pending" && card.health.state === "UNENROLLED";
}
