"use client";

import { useCallback, useEffect, useState } from "react";
import { Page } from "../../../components/shell/page.js";
import {
  Banner,
  Button,
  Card,
  ErrorNote,
  Field,
  inputClass,
  Spinner,
} from "../../../components/ui.js";
import { createChild, createDevice, getSetup, reissueCode } from "../../../lib/parent-api.js";

/**
 * `/setup` — add a child, add a Mac, get a code.
 *
 * ⚠️ **The code is shown once.** The server stores a SHA-256 and a
 * four-character hint, so "which code was that?" is answerable and "what was
 * the code?" is not. The page says so, because a parent who assumes they can
 * come back for it will close this tab.
 */
export default function SetupPage() {
  const [state, setState] = useState<Awaited<ReturnType<typeof getSetup>> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [freshCode, setFreshCode] = useState<{ code: string; expires_at: string } | null>(null);
  const [childName, setChildName] = useState("");
  const [deviceLabel, setDeviceLabel] = useState("");
  const [childId, setChildId] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await getSetup();
      setState(next);
      setChildId((current) => current || (next.children[0]?.id ?? ""));
      setError(null);
    } catch (caught) {
      setError(caught);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!state)
    return (
      <Page title="Add a Mac" back={{ href: "/devices", label: "Macs" }}>
        {error ? <ErrorNote error={error} /> : <Spinner />}
      </Page>
    );

  return (
    <Page title="Add a Mac" back={{ href: "/devices", label: "Macs" }}>
      {error ? (
        <div className="mb-4">
          <ErrorNote error={error} />
        </div>
      ) : null}

      {freshCode ? (
        <div className="mb-4">
          <Banner tone="ok" title="Type this into the installer on the Mac">
            <p className="my-2 select-all font-mono text-2xl tracking-wider text-foreground">
              {freshCode.code}
            </p>
            {/* ★ Once. Nothing stores it. */}
            <p>
              This is the only time it is shown — nothing stores it. It expires{" "}
              {new Date(freshCode.expires_at).toLocaleTimeString()}.
            </p>
          </Banner>
        </div>
      ) : null}

      <div className="space-y-4">
        <Card>
          <h2 className="font-heading text-lg font-medium tracking-tight">1. Who is it for?</h2>
          {state.children.length > 0 ? (
            <ul className="mt-2 text-sm text-foreground/85">
              {state.children.map((child) => (
                <li key={child.id}>
                  {child.displayName} {child.timezone ? `· ${child.timezone}` : null}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <Field label="Name">
              <input
                className={inputClass}
                value={childName}
                onChange={(event) => setChildName(event.target.value)}
                placeholder="Lucy"
              />
            </Field>
            <Button
              disabled={!childName || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await createChild({ display_name: childName });
                  setChildName("");
                  await refresh();
                } catch (caught) {
                  setError(caught);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Add
            </Button>
          </div>
        </Card>

        <Card>
          <h2 className="font-heading text-lg font-medium tracking-tight">2. Which Mac?</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="Child">
              <select
                className={inputClass}
                value={childId}
                onChange={(event) => setChildId(event.target.value)}
              >
                {state.children.map((child) => (
                  <option key={child.id} value={child.id}>
                    {child.displayName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="What to call it">
              <input
                className={inputClass}
                value={deviceLabel}
                onChange={(event) => setDeviceLabel(event.target.value)}
                placeholder="Lucy's Mac mini"
              />
            </Field>
          </div>
          <div className="mt-3">
            <Button
              variant="primary"
              disabled={!childId || !deviceLabel || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const created = await createDevice({ child_id: childId, label: deviceLabel });
                  setFreshCode({ code: created.code, expires_at: created.expires_at });
                  setDeviceLabel("");
                  await refresh();
                } catch (caught) {
                  setError(caught);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Add it and get a code
            </Button>
          </div>
        </Card>

        {state.devices.length > 0 ? (
          <Card>
            <h2 className="font-heading text-lg font-medium tracking-tight">Macs</h2>
            <ul className="mt-3 space-y-2 text-sm">
              {state.devices.map((device) => {
                const pending = state.pending_codes.find((row) => row.device_id === device.id);
                return (
                  <li key={device.id} className="flex flex-wrap items-center gap-3">
                    <span className="text-foreground">{device.label}</span>
                    <span className="text-muted-foreground">{device.status}</span>
                    {pending ? (
                      <span className="text-muted-foreground">
                        code {pending.hint}… {pending.expired ? "(expired)" : ""}
                      </span>
                    ) : null}
                    {device.status === "pending" ? (
                      <Button
                        variant="quiet"
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          try {
                            const issued = await reissueCode(device.id);
                            setFreshCode(issued);
                            await refresh();
                          } catch (caught) {
                            setError(caught);
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        New code
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {/* ⚠️ A live device cannot be handed a fresh code — that would
                let a second machine take over its identity while the first
                kept enforcing with a credential nobody knows about. */}
            <p className="mt-3 text-xs text-muted-foreground">
              A Mac that has already enrolled cannot be given a new code. Revoke it first.
            </p>
          </Card>
        ) : null}
      </div>
    </Page>
  );
}
