"use client";

import { DECOMMISSION, type DestructiveAction, REVOKE } from "@hpc/contract";
import { useState } from "react";
import { decommissionDevice, revokeDevice } from "../lib/parent-api.js";
import { Banner, Button, Field, inputClass } from "./ui.js";

/**
 * ★ Revoke and Decommission (§5.5), under Settings › Children & devices.
 *
 * Moved from the Mac's own page: ending an enrolment is managing the
 * household, like adding the device was, not something to do from the page
 * a parent opens to check on tonight.
 *
 * ⚠️ "The UI must make these typed-confirmation actions and must say what
 * each does, because they look similar and behave oppositely." Both the
 * description and the confirm word come from `@hpc/contract`, and the server
 * checks the word again — a confirmation only the browser enforces is one
 * anyone can skip.
 */
/** What just happened, for a confirmation that outlives the device's row. */
export interface EndedEnrolment {
  label: string;
  stopsEnforcement: boolean;
}

export function DeviceDangerZone({
  deviceId,
  onChanged,
}: {
  deviceId: string;
  onChanged: (done: EndedEnrolment) => void;
}) {
  return (
    <div className="space-y-3">
      <DestructiveRow
        action={REVOKE}
        deviceId={deviceId}
        run={revokeDevice}
        onChanged={onChanged}
      />
      <DestructiveRow
        action={DECOMMISSION}
        deviceId={deviceId}
        run={decommissionDevice}
        onChanged={onChanged}
      />
    </div>
  );
}

function DestructiveRow({
  action,
  deviceId,
  run,
  onChanged,
}: {
  action: DestructiveAction;
  deviceId: string;
  run: (id: string, confirm: string) => Promise<unknown>;
  onChanged: (done: EndedEnrolment) => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="rounded-lg border border-destructive/30 bg-card p-3">
      <p className="font-medium text-foreground">{action.label}</p>
      {/* ★ What it actually does, in the spec's own words — and the two say
          opposite things about enforcement. */}
      <p className="mt-1 text-sm text-foreground/85">{action.description}</p>
      <p className="text-sm text-muted-foreground">{action.useWhen}</p>
      {done ? (
        <div className="mt-2">
          <Banner tone="ok" title={`${action.label} done`}>
            {action.stopsEnforcement
              ? "This device will stop enforcing on its next check-in."
              : "This device keeps enforcing the rules it already has."}
          </Banner>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <Field label={`Type ${action.confirmWord} to confirm`}>
            <input
              className={inputClass}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder={action.confirmWord}
              autoComplete="off"
            />
          </Field>
          <Button
            variant="danger"
            disabled={typed !== action.confirmWord || busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await run(deviceId, typed);
                setDone(true);
                onChanged({ label: action.label, stopsEnforcement: action.stopsEnforcement });
              } catch (caught) {
                setError(caught instanceof Error ? caught.message : String(caught));
              } finally {
                setBusy(false);
              }
            }}
          >
            {action.label}
          </Button>
        </div>
      )}
      {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
