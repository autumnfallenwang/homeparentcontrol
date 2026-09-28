import { DAY_LABEL, DAYS } from "./format.js";

/**
 * Bedtime windows in plain words, for the rules page's summaries and its
 * review-before-publish panel.
 *
 * The review panel describes the COMPILED document — what the Mac will obey —
 * so these accept the policy document's shape as well as the editor's.
 */
export interface WindowLike {
  label?: string | null;
  days: readonly string[];
  restricted_from: string | null;
  restricted_until: string | null;
  action: string | null;
  shutdown_grace_s?: number | null;
}

export function minutesOf(hhmm: string | null): number {
  const [hours = "0", minutes = "0"] = (hhmm ?? "00:00").split(":");
  return Number(hours) * 60 + Number(minutes);
}

/** Length of a window in minutes; one that ends at or before it starts crosses midnight. */
export function windowMinutes(from: string | null, until: string | null): number {
  const start = minutesOf(from);
  const end = minutesOf(until);
  return end > start ? end - start : end + 24 * 60 - start;
}

/**
 * ⚠️ A "Lock, then shut down" window that can never reach the shutdown.
 *
 * The ladder shuts down only if bedtime STILL holds when the grace runs out,
 * and it checks once a minute — so the window has to outlast the grace by at
 * least a tick. On the second observed lock a 5-minute window against the
 * default 5-minute grace ended one tick short, and a test run was spent
 * learning it. The editor says so up front instead.
 */
export function neverShutsDown(window: WindowLike): boolean {
  if (window.action !== "shutdown") return false;
  const graceS = window.shutdown_grace_s ?? 300;
  return windowMinutes(window.restricted_from, window.restricted_until) * 60 <= graceS + 60;
}

export function describeDays(days: readonly string[]): string {
  if (days.length === 7) return "Every night";
  const ordered = DAYS.filter((day) => days.includes(day));
  return ordered.length > 0 ? ordered.map((day) => DAY_LABEL[day] ?? day).join(" ") : "No nights";
}

export function describeAction(action: string | null, graceS?: number | null): string {
  if (action === "shutdown") {
    return `Lock, then shut down after ${Math.round((graceS ?? 300) / 60)} min`;
  }
  if (action === "warn_only") return "Warn only";
  return "Lock the screen";
}

/** "Sun Mon Tue · 21:30 → 07:00 · Lock the screen" */
export function summarise(window: WindowLike): string {
  return [
    describeDays(window.days),
    `${window.restricted_from ?? "?"} → ${window.restricted_until ?? "?"}`,
    describeAction(window.action, window.shutdown_grace_s),
  ].join(" · ");
}

/**
 * The windows inside a compiled policy document. Defensive: the document is
 * `unknown` on the wire, and a review panel that throws is worse than one
 * that says it could not read the document.
 */
export function compiledWindows(document: unknown): WindowLike[] | null {
  const windows = (document as { schedule?: { windows?: unknown } } | null)?.schedule?.windows;
  if (!Array.isArray(windows)) return null;
  return windows.map((raw) => {
    const window = raw as Record<string, unknown>;
    const options = (window.action_options ?? {}) as Record<string, unknown>;
    return {
      label: typeof window.label === "string" ? window.label : null,
      days: Array.isArray(window.days) ? (window.days as string[]) : [],
      restricted_from: typeof window.restricted_from === "string" ? window.restricted_from : null,
      restricted_until:
        typeof window.restricted_until === "string" ? window.restricted_until : null,
      action: typeof window.action === "string" ? window.action : null,
      shutdown_grace_s:
        typeof options.shutdown_grace_s === "number" ? options.shutdown_grace_s : null,
    };
  });
}

/**
 * What else a publish changes, beyond the bedtime windows.
 *
 * ⚠️ The extra-time caps and the usage switch are compiled INTO the policy
 * document, so saving them changes nothing on the Mac until the next publish.
 * The old Settings page said "Saved" and stopped there; the Mac kept the old
 * caps. Now they are part of this review — and without these lines the panel
 * would ask the parent to publish while showing nothing different.
 */
export function settingChanges(current: unknown, proposed: unknown): string[] {
  const read = (document: unknown) => {
    const doc = (document ?? {}) as {
      override_policy?: { max_minutes_per_day?: unknown; max_grants_per_day?: unknown };
      telemetry?: { enabled?: unknown };
    };
    return {
      minutes: doc.override_policy?.max_minutes_per_day,
      grants: doc.override_policy?.max_grants_per_day,
      usage: doc.telemetry?.enabled,
    };
  };
  const before = read(current);
  const after = read(proposed);
  const onOff = (value: unknown) => (value === true ? "on" : value === false ? "off" : "not set");
  const lines: string[] = [];
  if (after.minutes !== before.minutes) {
    lines.push(`Extra time: up to ${before.minutes ?? "—"} → ${after.minutes ?? "—"} min a day`);
  }
  if (after.grants !== before.grants) {
    lines.push(`Grants a day: ${before.grants ?? "—"} → ${after.grants ?? "—"}`);
  }
  if (after.usage !== before.usage) {
    lines.push(`Usage data: ${onOff(before.usage)} → ${onOff(after.usage)}`);
  }
  return lines;
}
