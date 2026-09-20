/**
 * The sentences the parent actually reads.
 *
 * ⚠️ **The wording is load-bearing in four places and the spec names all
 * four.** These are not copy; they are the product behaving correctly. Each
 * one exists because the natural phrasing says something false:
 *
 * 1. **The still-enforcing banner (§4.6).** "Offline" makes a parent think
 *    the rules stopped. The opposite is true — a stale policy is still being
 *    enforced, and can only ever converge *stricter*, because every
 *    relaxation carries a mandatory `expires_at`.
 * 2. **The no-unlock sentence (§3.5).** A late grant does **not** unlock the
 *    Mac. Nothing third-party can draw over the macOS lock screen. The grant
 *    moves the boundary, the enforcer stops re-locking, and the child logs
 *    back in herself.
 * 3. **Revoke vs Decommission (§5.5).** They look alike and behave
 *    oppositely — one keeps enforcing, one stops everything.
 * 4. **The `active_s` label (§5.8).** "Screen time" reads as "time the Mac
 *    was on". A.33's meter is time she was *using* it.
 *
 * ⚠️ **Why this lives in `packages/contract` rather than in the web app.**
 * R9's reason for the package is that a definition consumed by two sides
 * should have one home. These strings are consumed by the UI and asserted by
 * tests on both sides; putting them in `apps/web` would let the API's own
 * notification text drift from the page's, and the drift would be invisible
 * because both would still be grammatical English.
 *
 * `wording.test.ts` pins the load-bearing clauses so a well-meaning tidy-up
 * shows up as a failing test rather than as a parent misunderstanding what
 * their child's Mac is doing.
 */

/** Substituted into the sentences below. */
export interface Subject {
  /** The child's display name, e.g. "Lucy". */
  childName: string;
  /** How the parent refers to the machine, e.g. "Lucy's Mac". */
  deviceLabel: string;
}

// ── 1. Health, in plain language (§4.6, §7.3).

export type HealthState =
  | "UNENROLLED"
  | "HEALTHY"
  | "DEGRADED"
  | "EXPECTED_OFFLINE"
  | "UNEXPECTED_SILENCE"
  | "SILENT_TOO_LONG";

export interface HealthPhrasing {
  /** One short line for the card. */
  headline: string;
  /** The sentence that corrects the natural misreading. Null when there is none to correct. */
  reassurance: string | null;
  /** How alarmed the card should look. */
  tone: "ok" | "info" | "warn" | "alarm";
}

/**
 * ⚠️ `lastPolicyDay` is the human day the cached rules were published, e.g.
 * "Tuesday" — NOT the day the device last synced. The sentence is about which
 * rules are in force, and those are the last ones it successfully applied.
 */
export function healthPhrasing(
  state: HealthState,
  subject: Subject,
  context: { silentFor?: string; lastPolicyDay?: string; degradedReason?: string } = {},
): HealthPhrasing {
  const { deviceLabel } = subject;
  const since = context.silentFor ?? "a while";
  const rulesFrom = context.lastPolicyDay
    ? `the rules from ${context.lastPolicyDay}`
    : "the rules it already has";

  switch (state) {
    case "HEALTHY":
      return { headline: `${deviceLabel} is checking in normally.`, reassurance: null, tone: "ok" };

    case "UNENROLLED":
      return {
        headline: `${deviceLabel} has not been set up yet.`,
        reassurance: "Nothing is being enforced on it.",
        tone: "info",
      };

    case "EXPECTED_OFFLINE":
      // Not a problem, and must not be dressed as one. Overnight silence on a
      // Mac that is meant to be off is the system working.
      return {
        headline: `${deviceLabel} is off or asleep, as expected.`,
        reassurance: `It will pick up ${rulesFrom} when it starts.`,
        tone: "ok",
      };

    // ★ The two below carry the §4.6 sentence. "The natural parental fear on
    // seeing 'offline' is 'so the rules aren't working', which is the exact
    // opposite of the truth."
    case "UNEXPECTED_SILENCE":
      return {
        headline: `${deviceLabel} hasn't checked in for ${since}.`,
        reassurance: `It is still enforcing ${rulesFrom}.`,
        tone: "warn",
      };

    case "SILENT_TOO_LONG":
      return {
        headline: `${deviceLabel} hasn't checked in for ${since}.`,
        reassurance: `It is still enforcing ${rulesFrom}.`,
        tone: "alarm",
      };

    // ★ The one state where the reassurance would be a LIE. DEGRADED means
    // the agent cannot determine the rules, so it is failing open — loudly,
    // which is this line.
    case "DEGRADED":
      return {
        headline: `${deviceLabel} is not enforcing — its rules are missing or unreadable.`,
        reassurance: null,
        tone: "alarm",
      };
  }
}

// ── 2. The no-unlock sentence (§3.5).

/**
 * ★ Shown wherever a grant can be made while enforcement has already fired.
 *
 * ⚠️ Do not soften this into "she'll be back in straight away". The two
 * clauses do different jobs: the first sets the expectation (~5 s, not
 * instant), the second kills the belief that the parent has just woken the
 * machine up for her. A parent who thinks the Mac is now unlocked and walks
 * away has been misled by the UI.
 */
export const LATE_GRANT_DOES_NOT_UNLOCK =
  "She'll be able to log back in within about 5 seconds. " + "This won't wake the Mac for her.";

/** The same fact, phrased for a child whose name we have. */
export function lateGrantDoesNotUnlock(subject: Subject): string {
  return (
    `${subject.childName} will be able to log back in within about 5 seconds. ` +
    "This won't wake the Mac for her."
  );
}

/**
 * ⚠️ D.5 — when the device is offline, the sentence ENDS. There is no offline
 * code to read out, and hinting at one invents a feature the design deleted.
 */
export function grantWillApplyWhenReconnected(subject: Subject, silentFor: string): string {
  return (
    `${subject.deviceLabel} hasn't checked in for ${silentFor}. ` +
    "This grant will apply when it reconnects."
  );
}

// ── 3. Revoke vs Decommission (§5.5).

export interface DestructiveAction {
  label: string;
  /** What it actually does, in the spec's own words. */
  description: string;
  /** When to use it. */
  useWhen: string;
  /** ⚠️ Both are typed-confirmation actions. */
  confirmWord: string;
  stopsEnforcement: boolean;
}

export const REVOKE: DestructiveAction = {
  label: "Revoke credential",
  description: "The Mac stops talking to the server but keeps enforcing bedtime.",
  useWhen: "Use this if you think the credential leaked.",
  confirmWord: "REVOKE",
  stopsEnforcement: false,
};

export const DECOMMISSION: DestructiveAction = {
  label: "Decommission device",
  description: "The agent uninstalls itself and stops enforcing anything.",
  useWhen: "Use this when the Mac is leaving the house.",
  confirmWord: "DECOMMISSION",
  stopsEnforcement: true,
};

// ── 4. The `active_s` label (§5.8).

/** ★ "Screen time" reads as "time the Mac was switched on". It is not that. */
export const ACTIVE_TIME_LABEL = "Active time";
export const ACTIVE_TIME_EXPLANATION =
  "Minutes she was actually using the Mac, not minutes it was switched on.";

// ── Shadow mode (§6.5). Not one of the four, but the same class of claim.

/**
 * ★ A soaking device is deliberately NOT enforcing, and the parent must be
 * told so in those words.
 *
 * ⚠️ This is the same rule as `DEGRADED`'s: fail-open is only defensible
 * while it is loud. The difference is that this one is *intended*, which
 * makes it more tempting to phrase gently — "trying out a new version",
 * "verifying the update". Those all leave a parent believing bedtime will
 * happen tonight. It will not.
 *
 * The second sentence is the part that stops this reading as an outage: the
 * window is bounded and ends on its own.
 */
export function shadowModeNotEnforcing(subject: Subject, until?: string): string {
  const when = until ? ` It starts enforcing again ${until}.` : " It starts enforcing again soon.";
  return `${subject.deviceLabel} is checking a new version and is NOT enforcing bedtime.` + when;
}

// ── Not one of the four, but the same class of mistake.

/**
 * ⚠️ There is no "disable enforcement" anywhere in the product, and no route
 * to add one later. The nearest legal action is a `suspend` override with a
 * mandatory `expires_at`.
 */
export const SUSPEND_IS_NOT_OFF = "No bedtime tonight";

/**
 * §5.7's first honesty rule: "zero usage and no data look identical on a bar
 * chart and mean opposite things".
 */
export const NO_DATA_FOR_PERIOD = "No data — the Mac wasn't reporting.";
export const ZERO_USAGE_FOR_PERIOD = "Not used.";

// ── The one tripwire banner (§5.2, §5.8).

/**
 * ★ §5.8: "**one** tripwire banner not eight".
 *
 * The `tripwires` table stores a `kind` and nothing else human-readable —
 * deliberately, because a summary frozen into a row at raise time cannot be
 * improved later. The phrasing lives here instead, where it is shared and
 * tested.
 *
 * ⚠️ **None of these is an alert.** §5.2: under AR.1 a tripwire "deliberately
 * never" becomes a notification. "The value is that the history exists when
 * someone later asks *has she ever tried?* — not that anyone is paged." The
 * severity below orders the banner; it does not page anyone.
 */
export type TripwireSeverity = "info" | "warn" | "alarm";

export interface TripwirePhrasing {
  severity: TripwireSeverity;
  /** What happened, in a sentence a parent can act on. */
  summary: string;
  /** Why it might be innocent. ⚠️ Present on every kind that HAS an innocent explanation. */
  benign: string | null;
}

export function tripwirePhrasing(kind: string, subject: Subject): TripwirePhrasing {
  const { childName, deviceLabel } = subject;

  switch (kind) {
    // ⚠️ The only two that suggest deliberate interference, and even these
    // are phrased as observations rather than accusations. A banner that
    // says "Lucy tampered with the agent" and turns out to be a router
    // change costs more trust than it protects.
    case "kill_switch_present":
      return {
        severity: "alarm",
        summary: `The emergency off-switch file is present on ${deviceLabel}, so it is not enforcing.`,
        benign: "You may have put it there yourself. It is removed by deleting the file.",
      };
    case "signature_invalid":
      return {
        severity: "alarm",
        summary: `${deviceLabel} received rules it could not verify, and kept the ones it already had.`,
        benign: "Most often a signing-key change on the server rather than anything on the Mac.",
      };

    case "agent_stopped_while_up":
      return {
        severity: "warn",
        summary: `The agent on ${deviceLabel} stopped while the Mac stayed on.`,
        benign: "A crash and an update both look like this.",
      };
    case "policy_version_regression":
      return {
        severity: "warn",
        summary: `${deviceLabel} reported older rules than it had already applied.`,
        benign: "Usually a restore from a backup, or a reinstall.",
      };
    case "hardware_uuid_mismatch":
      return {
        severity: "warn",
        summary: `${deviceLabel} is reporting a different machine identity than it enrolled with.`,
        benign: "A logic-board replacement does this legitimately.",
      };
    case "concurrent_boot_ids":
      return {
        severity: "warn",
        summary: `Two copies of the agent appear to be running for ${childName}.`,
        benign: "A restored disk image or a clone will do this.",
      };

    case "network_time_disabled":
      return {
        severity: "warn",
        summary: `${deviceLabel} is no longer syncing its clock with the network.`,
        // ⚠️ Worth saying plainly: the clock is not a way around bedtime.
        benign: "Bedtime still applies — the rules use the timezone in the policy, not the Mac's.",
      };
    case "timezone_mismatch":
      return {
        severity: "info",
        summary: `${deviceLabel}'s timezone differs from the one in ${childName}'s rules.`,
        benign:
          "Bedtime follows the rules' timezone, so this changes nothing about when it applies.",
      };
    case "unexpected_source_ip":
      return {
        severity: "info",
        summary: `${deviceLabel} checked in from an address it has not used before.`,
        benign: "A new Wi-Fi network or a router change.",
      };

    default:
      // R5 — an unknown kind degrades to something showable rather than to a
      // blank banner or a crash. A future server can raise a kind this build
      // has never heard of.
      return {
        severity: "info",
        summary: `${deviceLabel} reported something worth noting (${kind}).`,
        benign: null,
      };
  }
}

/** "and 3 others" — the count, never the list. */
export function alsoOpen(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? "and 1 other" : `and ${count} others`;
}
