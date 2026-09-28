"use client";

import { AlertTriangle, CheckCircle2, Pencil, Plus } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Page, SectionTitle } from "../../../components/shell/page.js";
import { useViewing } from "../../../components/shell/viewing.js";
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
} from "../../../components/ui.js";
import { DAY_LABEL, DAYS, dayAndTime } from "../../../lib/format.js";
import {
  getRules,
  getRulesDiff,
  getRulesHistory,
  patchSettings,
  publishRules,
  type RulesPayload,
  type RuleWindow,
  restoreVersion,
  saveRules,
} from "../../../lib/parent-api.js";
import { publishTargets } from "../../../lib/publish-target.js";
import {
  compiledWindows,
  describeAction,
  describeDays,
  neverShutsDown,
  settingChanges,
  summarise,
} from "../../../lib/rule-summary.js";

/**
 * `/rules` — edit, review, publish, plus the history inline.
 *
 * ★ **The review shows the COMPILED document**, because that is what the
 * agent obeys. A diff of the windows the parent just edited would hide the
 * holidays, the calendar exceptions and the live grants the compiler folds
 * in — so a parent could move bedtime and never learn that Monday is a
 * holiday and the window is suspended anyway.
 *
 * ⚠️ Rebuilt after the first real runs, which lost two test windows to this
 * page: the action was a dropdown left on its default, and "Save draft" then
 * a separate "Publish" read as one step. Now the action is a visible choice,
 * each window is summarised in words, and one sticky bar carries the edit
 * through review to publish. The draft → review → publish order (§5.8) is
 * unchanged; only its controls are.
 *
 * Whose rules: the child picked in the sidebar's Viewing switch. The page
 * used to carry its own picker, which could disagree with every other page.
 */
export default function RulesPage() {
  const [rules, setRules] = useState<RulesPayload | null>(null);
  const [windows, setWindows] = useState<RuleWindow[]>([]);
  const [setId, setSetId] = useState<string | null>(null);
  const viewing = useViewing();
  const childId = viewing.child?.id ?? null;
  const [deviceId, setDeviceId] = useState<string>("");
  const [editing, setEditing] = useState<number | null>(null);
  const [diff, setDiff] = useState<Awaited<ReturnType<typeof getRulesDiff>> | null>(null);
  const [history, setHistory] = useState<Awaited<ReturnType<typeof getRulesHistory>> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const loadRules = useCallback(async () => {
    try {
      setRules(await getRules());
    } catch (caught) {
      setError(caught);
    }
  }, []);

  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  const saved = useMemo(
    () => rules?.policy_sets.find((candidate) => candidate.child_id === childId) ?? null,
    [rules, childId],
  );

  useEffect(() => {
    setSetId(saved?.id ?? null);
    setWindows(saved?.windows ?? []);
    setEditing(null);
  }, [saved]);

  const targets = useMemo(
    () => publishTargets(viewing.devices, childId),
    [viewing.devices, childId],
  );
  const target = targets.find((device) => device.id === deviceId);

  // Keep the parent's pick while it is still valid; otherwise the best target.
  useEffect(() => {
    setDeviceId((current) =>
      targets.some((device) => device.id === current) ? current : (targets[0]?.id ?? ""),
    );
  }, [targets]);

  const loadDiff = useCallback(async () => {
    // Clear, not keep: the last child's review — and its Publish button —
    // must not stay on screen once there is no Mac to publish to.
    if (!deviceId) {
      setDiff(null);
      setHistory(null);
      return;
    }
    try {
      setDiff(await getRulesDiff(deviceId));
      setHistory(await getRulesHistory(deviceId));
    } catch (caught) {
      setError(caught);
    }
  }, [deviceId]);

  useEffect(() => {
    void loadDiff();
  }, [loadDiff]);

  /** Edits on this page not yet saved to the server. */
  const unsaved = JSON.stringify(windows) !== JSON.stringify(saved?.windows ?? []);

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

  /** Save the draft, then fetch the compiled review. Nothing reaches the Mac. */
  const review = () =>
    run(async () => {
      if (!setId) return;
      await saveRules(setId, windows);
      await loadRules();
      await loadDiff();
      setEditing(null);
    });

  const publish = () =>
    run(async () => {
      if (!diff) return;
      await publishRules(deviceId, diff.confirm_immediate_effect);
      await loadDiff();
    });

  if (!rules) {
    return <Page title="Rules">{error ? <ErrorNote error={error} /> : <Spinner />}</Page>;
  }

  const childName = viewing.child?.displayName ?? "your child";

  /** Caps are saved at once, like a draft; the review below then shows them. */
  const saveLimits = (patch: {
    override_max_minutes_per_day?: number;
    override_max_grants_per_day?: number;
  }) =>
    run(async () => {
      if (!setId) return;
      await patchSettings({ policy_set_id: setId, ...patch });
      await loadRules();
      await loadDiff();
    });

  return (
    <Page
      title="Rules"
      subtitle={target ? `${childName} · publishes to ${target.label ?? "this Mac"}` : childName}
    >
      {error ? <ErrorNote error={error} /> : null}

      {viewing.children !== null && !viewing.child ? (
        <Banner tone="info" title="No children yet">
          Add a child in{" "}
          <Link href="/settings/children" className="underline">
            Settings › Children &amp; devices
          </Link>{" "}
          to set their bedtime.
        </Banner>
      ) : null}

      {windows.length === 0 ? (
        <Banner tone="info" title="No bedtime yet">
          Add a window to set when {childName}'s Mac locks.
        </Banner>
      ) : null}

      {windows.map((window, index) =>
        editing === index ? (
          <WindowEditor
            key={window.id ?? `new-${index}`}
            window={window}
            onChange={(next) =>
              setWindows((current) =>
                current.map((item, position) => (position === index ? next : item)),
              )
            }
            onDone={() => setEditing(null)}
            onRemove={() => {
              setWindows((current) => current.filter((_, position) => position !== index));
              setEditing(null);
            }}
          />
        ) : (
          <WindowSummary
            key={window.id ?? `new-${index}`}
            window={window}
            onEdit={() => setEditing(index)}
          />
        ),
      )}

      <Button
        onClick={() => {
          setWindows((current) => [
            ...current,
            {
              label: "Bedtime",
              days: ["sun", "mon", "tue", "wed", "thu"],
              restricted_from: "21:30",
              restricted_until: "07:00",
              action: "lock",
              shutdown_grace_s: 300,
              escalate_after_failures: 3,
              warnings: [
                { lead_minutes: 30, channel: "banner" },
                { lead_minutes: 15, channel: "banner" },
                { lead_minutes: 5, channel: "modal" },
                { lead_minutes: 1, channel: "modal" },
              ],
            },
          ]);
          setEditing(windows.length);
        }}
      >
        <Plus className="h-4 w-4" />
        Add a window
      </Button>

      {/*
        ⚠️ Say WHICH Mac, always. A publish that lands on the wrong device
        returns 200 and changes nothing the child can see — the parent has no
        other way to notice.
      */}
      {saved ? (
        <LimitsCard key={saved.id} caps={saved.override_caps} busy={busy} onSave={saveLimits} />
      ) : null}

      {viewing.child && viewing.children !== null && targets.length === 0 ? (
        <Banner tone="warn" title="No device to publish to yet">
          Save your rules now — a device receives the saved rules automatically when it finishes
          enrolling. After that, changes are published from here. Add a device or check its code in{" "}
          <Link href="/settings/children" className="underline">
            Settings › Children &amp; devices
          </Link>
          .
        </Banner>
      ) : null}
      {targets.length > 1 ? (
        <Field label="Publish to">
          <select
            className={inputClass}
            value={deviceId}
            onChange={(event) => setDeviceId(event.target.value)}
          >
            {targets.map((device) => (
              <option key={device.id} value={device.id}>
                {device.label ?? device.id}
              </option>
            ))}
          </select>
        </Field>
      ) : null}

      {!unsaved && diff?.changed ? (
        <ReviewPanel
          diff={diff}
          macName={target?.label ?? "this Mac"}
          busy={busy}
          onPublish={publish}
        />
      ) : null}

      {!unsaved && diff && !diff.changed ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <CheckCircle2 className="h-4 w-4 text-ok" />
          {target?.label ?? "The Mac"} has these rules
          {diff.current_version !== null ? ` (version ${diff.current_version})` : ""}.
        </p>
      ) : null}

      {history && history.versions.length > 0 ? (
        <details className="rounded-xl border border-border bg-card p-4 sm:p-5">
          <summary className="cursor-pointer font-heading text-lg font-medium tracking-tight">
            History
          </summary>
          {/* ⚠️ Restore publishes a NEW version with the old content. It
              never rewinds — `git revert` applied to bedtime. */}
          <p className="mt-1 text-sm text-muted-foreground">
            Restoring publishes a new version with the old rules. Nothing in this list ever changes.
          </p>
          <ul className="mt-3 space-y-2 text-sm">
            {history.versions.map((version) => (
              <li key={version.version} className="flex flex-wrap items-center gap-3">
                <span className="w-12 shrink-0 tabular-nums text-muted-foreground">
                  v{version.version}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {dayAndTime(version.issued_at)}
                </span>
                <span className="text-foreground/85">{version.reason ?? "—"}</span>
                <Button
                  variant="quiet"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await restoreVersion(deviceId, version.version);
                      await loadDiff();
                    })
                  }
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {/*
        The one bar that carries an edit through. Saving is not publishing,
        and the bar says so — a parent who thinks "Save" shipped it will not
        publish.
      */}
      {unsaved ? (
        <div className="sticky bottom-4 z-10 rounded-xl border border-attention/45 bg-card p-3 shadow-lg">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm">
              <span className="font-medium">Unsaved changes.</span>{" "}
              <span className="text-muted-foreground">Nothing has reached the Mac yet.</span>
            </p>
            <div className="flex gap-2">
              <Button
                variant="quiet"
                disabled={busy}
                onClick={() => {
                  setWindows(saved?.windows ?? []);
                  setEditing(null);
                }}
              >
                Discard
              </Button>
              <Button variant="primary" disabled={busy || !setId} onClick={review}>
                {targets.length > 0 ? "Review changes" : "Save"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </Page>
  );
}

function WindowSummary({ window, onEdit }: { window: RuleWindow; onEdit: () => void }) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <SectionTitle>{window.label || "Bedtime"}</SectionTitle>
            <Badge tone={window.action === "shutdown" ? "warn" : "plain"}>
              {window.action === "shutdown" ? "Lock, then shut down" : "Lock the screen"}
            </Badge>
          </div>
          <p className="mt-1 text-sm">
            {describeDays(window.days)} · {window.restricted_from} → {window.restricted_until}
          </p>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Warnings{" "}
            {window.warnings.length > 0
              ? window.warnings.map((warning) => warning.lead_minutes).join(" · ")
              : "none"}{" "}
            min before
          </p>
          {neverShutsDown(window) ? <TooShortNote /> : null}
        </div>
        <Button variant="quiet" onClick={onEdit}>
          <Pencil className="h-4 w-4" />
          Edit
        </Button>
      </div>
    </Card>
  );
}

function TooShortNote() {
  return (
    <p className="mt-2 flex items-center gap-1.5 text-[13px] text-attention-text">
      <AlertTriangle className="h-4 w-4 text-attention" />
      Too short to ever shut down — it only locks. Make it longer than the grace.
    </p>
  );
}

function WindowEditor({
  window,
  onChange,
  onDone,
  onRemove,
}: {
  window: RuleWindow;
  onChange: (next: RuleWindow) => void;
  onDone: () => void;
  onRemove: () => void;
}) {
  return (
    <Card tone="info">
      <div className="space-y-4">
        <Field label="Name">
          <input
            className={inputClass}
            value={window.label}
            onChange={(event) => onChange({ ...window, label: event.target.value })}
          />
        </Field>

        <fieldset>
          <legend className="mb-1 text-[13px] font-medium text-foreground/80">Nights</legend>
          <div className="flex flex-wrap gap-1">
            {DAYS.map((day) => {
              const on = window.days.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    onChange({
                      ...window,
                      days: on ? window.days.filter((item) => item !== day) : [...window.days, day],
                    })
                  }
                  className={`min-h-11 min-w-11 rounded-lg border px-2 text-sm ${
                    on
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-card text-muted-foreground"
                  }`}
                >
                  {DAY_LABEL[day]}
                </button>
              );
            })}
          </div>
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="From">
            <input
              type="time"
              className={inputClass}
              value={window.restricted_from}
              onChange={(event) => onChange({ ...window, restricted_from: event.target.value })}
            />
          </Field>
          <Field label="Until">
            <input
              type="time"
              className={inputClass}
              value={window.restricted_until}
              onChange={(event) => onChange({ ...window, restricted_until: event.target.value })}
            />
          </Field>
        </div>

        <div>
          {/*
            ⚠️ Two values, and that is A.34 made visible. The vocabulary IS
            the boundary: nothing here can express "disable Remote Login" or
            "change FileVault". A third option is a schema migration and an
            ADR, not another button.
          */}
          <SegmentedControl
            label="When bedtime starts"
            value={window.action}
            options={[
              { value: "lock", label: "Lock the screen" },
              { value: "shutdown", label: "Lock, then shut down" },
            ]}
            onChange={(action) => onChange({ ...window, action })}
          />
          {window.action === "shutdown" ? (
            <div className="mt-3 max-w-xs">
              <Field label="Shut down if still locked after (minutes)">
                <input
                  type="number"
                  min={0}
                  max={60}
                  className={inputClass}
                  value={Math.round(window.shutdown_grace_s / 60)}
                  onChange={(event) =>
                    onChange({
                      ...window,
                      shutdown_grace_s: Math.max(0, Math.min(60, Number(event.target.value))) * 60,
                    })
                  }
                />
              </Field>
            </div>
          ) : null}
          {neverShutsDown(window) ? <TooShortNote /> : null}
        </div>

        <p className="text-[13px] text-muted-foreground">{summarise(window)}</p>

        <div className="flex flex-wrap justify-between gap-2">
          <Button variant="danger" onClick={onRemove}>
            Remove this window
          </Button>
          <Button onClick={onDone}>Done</Button>
        </div>
      </div>
    </Card>
  );
}

/**
 * What the Mac will obey, in words, before it is published — the compiled
 * document, not the edit.
 */
function ReviewPanel({
  diff,
  macName,
  busy,
  onPublish,
}: {
  diff: NonNullable<Awaited<ReturnType<typeof getRulesDiff>>>;
  macName: string;
  busy: boolean;
  onPublish: () => void;
}) {
  const compiled = compiledWindows(diff.proposed_document);
  const alsoChanging = settingChanges(diff.current_document, diff.proposed_document);
  return (
    <Card tone={diff.confirm_immediate_effect ? "warn" : "ok"}>
      <SectionTitle>Ready to publish to {macName}</SectionTitle>
      <p className="mt-1 text-sm text-muted-foreground">
        This is what the Mac will obey — holidays, calendar exceptions and tonight's grants already
        folded in.
      </p>

      {compiled && compiled.length > 0 ? (
        <ul className="mt-3 space-y-1.5 text-sm">
          {compiled.map((window) => (
            <li key={`${window.label}|${window.days.join()}|${window.restricted_from}`}>
              <span className="font-medium">{window.label ?? "Window"}</span>
              <span className="text-muted-foreground"> — </span>
              {describeDays(window.days)} · {window.restricted_from} → {window.restricted_until} ·{" "}
              <span className={window.action === "shutdown" ? "font-medium" : undefined}>
                {describeAction(window.action, window.shutdown_grace_s)}
              </span>
            </li>
          ))}
        </ul>
      ) : compiled ? (
        <p className="mt-3 text-sm">No bedtime windows — the Mac will not lock.</p>
      ) : null}

      {alsoChanging.length > 0 ? (
        <div className="mt-3 text-sm">
          <p className="font-medium">Also changing</p>
          <ul className="mt-1 space-y-0.5 text-foreground/85">
            {alsoChanging.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/*
        ★ C3. The guard fires ONLY on a tightening that bites within 15
        minutes. "Firing the guard on every +30-minute grant trains the parent
        to click through it in exactly the case it was built for."
      */}
      {diff.confirm_immediate_effect ? (
        <div className="mt-3">
          <Banner tone="warn" title="This takes effect almost immediately">
            {diff.confirm_reason ??
              "A window is about to start. Publishing now could lock the Mac mid-use."}
          </Banner>
        </div>
      ) : null}

      <details className="mt-3">
        <summary className="cursor-pointer text-[13px] text-muted-foreground">
          Show the compiled document
        </summary>
        <pre className="mt-2 max-h-80 overflow-auto rounded-lg border border-border bg-secondary p-3 text-xs text-foreground">
          {JSON.stringify(diff.proposed_document, null, 2)}
        </pre>
      </details>

      <div className="mt-4">
        <Button variant="primary" disabled={busy} onClick={onPublish}>
          {diff.confirm_immediate_effect ? "Publish anyway" : "Publish"}
        </Button>
      </div>
    </Card>
  );
}

/**
 * Extra time limits — moved here from Settings, because they belong to one
 * child's rules like the windows above them do.
 *
 * ⚠️ They are compiled into the policy document, so saving one changes
 * nothing on the Mac until the next publish. The old Settings page said
 * "Saved" and stopped; the Mac kept the old caps. Here the review panel
 * appears straight after, naming the change.
 */
function LimitsCard({
  caps,
  busy,
  onSave,
}: {
  caps: { max_minutes_per_day: number; max_grants_per_day: number };
  busy: boolean;
  onSave: (patch: {
    override_max_minutes_per_day?: number;
    override_max_grants_per_day?: number;
  }) => Promise<void>;
}) {
  return (
    <Card>
      <SectionTitle>Extra time limits</SectionTitle>
      <p className="mt-1 text-sm text-muted-foreground">
        The most the +15 / +30 / +60 buttons can add. Enforced on the Mac as well as here, so these
        numbers are what actually happens once published.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Extra time allowed per day (minutes)">
          <input
            type="number"
            className={inputClass}
            defaultValue={caps.max_minutes_per_day}
            min={0}
            max={480}
            disabled={busy}
            onBlur={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next) && next !== caps.max_minutes_per_day) {
                void onSave({ override_max_minutes_per_day: next });
              }
            }}
          />
        </Field>
        <Field label="Grants allowed per day">
          <input
            type="number"
            className={inputClass}
            defaultValue={caps.max_grants_per_day}
            min={0}
            max={10}
            disabled={busy}
            onBlur={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next) && next !== caps.max_grants_per_day) {
                void onSave({ override_max_grants_per_day: next });
              }
            }}
          />
        </Field>
      </div>
    </Card>
  );
}
