import type { HealthState, TripwireSeverity } from "@hpc/contract";
import { apiBaseUrl } from "./api.js";

/**
 * The parent API, typed.
 *
 * ⚠️ Hand-written types rather than generated ones, for the same reason
 * `packages/contract` is hand-written zod: the wire shape is a contract, and
 * generating it from the handler makes every handler change a silent client
 * change. When these drift, the page breaks loudly at the boundary instead of
 * rendering something subtly wrong.
 */

const BASE = "/api/parent/v1";

export class ParentApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public reason?: string,
  ) {
    super(message);
    this.name = "ParentApiError";
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl()}${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
    // The parent session is a cookie; the agent's `x-api-key` never appears
    // in this app.
    credentials: "include",
    cache: "no-store",
  });
  if (response.status === 204) return undefined as T;

  // ⚠️ A 401 means the session expired, and every page in this app needs
  // one. Handled here rather than in eight `catch` blocks, because the one
  // that gets forgotten shows a parent "Request failed (401)" on the page
  // they opened to settle an argument.
  if (response.status === 401 && typeof window !== "undefined") {
    window.location.href = "/sign-in";
  }

  const body = (await response.json().catch(() => null)) as {
    error?: string;
    reason?: string;
  } | null;
  if (!response.ok) {
    throw new ParentApiError(
      response.status,
      body?.error ?? `Request failed (${response.status})`,
      body?.reason,
    );
  }
  return body as T;
}

const post = <T>(path: string, body?: unknown) =>
  call<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

// ── Today

export interface TripwireBanner {
  id: string;
  kind: string;
  severity: TripwireSeverity;
  summary: string;
  benign: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  occurrences: number;
  also_open: number;
}

export interface DeviceCard {
  device_id: string;
  label: string | null;
  status: string;
  child: { id: string; display_name: string | null; timezone: string | null } | null;
  health: {
    state: HealthState;
    reason: string | null;
    since: string | null;
    last_sync_at: string | null;
    silent_for_s: number | null;
    applied_policy_version: number | null;
    applied_policy_at: string | null;
  };
  attended_until: string | null;
  agent_version: string | null;
  tonight: {
    policy_version: number;
    windows: {
      label: string | null;
      days: string[];
      restricted_from: string | null;
      restricted_until: string | null;
      action: string | null;
    }[];
  } | null;
  active_grants: {
    id: string;
    type: string;
    minutes: number | null;
    effective_date: string;
    expires_at: string;
    reason: string | null;
  }[];
  usage_today: {
    local_day: string;
    active_s: number;
    foreground_s: number;
    top_apps: { bundle_id: string; active_s: number; foreground_s: number }[];
  };
  banner: TripwireBanner | null;
  last_enforcement: {
    kind: string;
    summary: string;
    at: string;
    is_locked_now: boolean;
  } | null;
}

export const getToday = () => call<{ generated_at: string; devices: DeviceCard[] }>("/today");

// ── Devices

export interface DeviceDetail {
  device: {
    id: string;
    label: string | null;
    status: string;
    child: { id: string; display_name: string | null; timezone: string | null } | null;
    hardware_uuid: string | null;
    hostname: string | null;
    model: string | null;
    os_version: string | null;
    arch: string | null;
    agent_version: string | null;
    applied_policy_version: number | null;
    attended_until: string | null;
    away_until: string | null;
  };
  health: {
    state: HealthState;
    reason: string | null;
    since: string | null;
    last_sync_at: string | null;
    self_reported_reason: string | null;
  };
  clock: { last_boot_id: string | null; system_boot_time: string | null };
  timeline: {
    state: string;
    reason: string | null;
    entered_at: string;
    exited_at: string | null;
    reclassified_from: string | null;
  }[];
  session_spans: { kind: string; started_at: string; ended_at: string | null }[];
  enforcement: { kind: string; summary: string; at: string; policy_version: number | null }[];
  tripwires: {
    id: string;
    kind: string;
    first_seen_at: string | null;
    last_seen_at: string | null;
    occurrences: number;
    acknowledged_at: string | null;
    detail: unknown;
  }[];
  desired: { id: string; kind: string; status: string }[];
}

export const getDevice = (id: string) => call<DeviceDetail>(`/devices/${id}`);

/**
 * ⚠️ Called from the device page's `useEffect`, not from its data fetch.
 * It is a deliberate write — it puts the device into 5-second polling for ten
 * minutes — and a prefetch must never trigger it.
 */
export const attendDevice = (id: string) =>
  post<{ attended_until: string }>(`/devices/${id}/attend`);

export const setAway = (id: string, until: string) =>
  post<{ away_until: string }>(`/devices/${id}/away`, { until });

export const revokeDevice = (id: string, confirm: string) =>
  post<{ status: string; stops_enforcement: boolean }>(`/devices/${id}/revoke`, { confirm });

export const decommissionDevice = (id: string, confirm: string) =>
  post<{ status: string; stops_enforcement: boolean }>(`/devices/${id}/decommission`, {
    confirm,
  });

// ── Overrides

export interface GrantResult {
  override_id: string;
  /** ★ Always `sent`. "Applied" is the agent's word — see `/override`. */
  state: "sent";
  sent_at: string;
  expires_at: string;
  awaiting_policy_version: number | null;
}

export const grantOverride = (input: {
  device_id: string;
  type?: "extend" | "suspend";
  minutes?: number;
  reason?: string;
}) => post<GrantResult>("/overrides", input);

export const revokeOverride = (id: string) =>
  call<{ revoked: boolean }>(`/overrides/${id}`, { method: "DELETE" });

export const listOverrides = () =>
  call<{
    overrides: {
      id: string;
      device_id: string | null;
      type: string;
      minutes: number | null;
      effective_date: string;
      expires_at: string;
      revoked_at: string | null;
      reason: string | null;
      granted_via: string;
      created_at: string;
      live: boolean;
    }[];
  }>("/overrides");

// ── Rules

export interface RuleWindow {
  id?: string;
  label: string;
  days: string[];
  restricted_from: string;
  restricted_until: string;
  crosses_midnight?: boolean;
  action: "lock" | "shutdown";
  shutdown_grace_s: number;
  escalate_after_failures: number;
  warnings: { lead_minutes: number; channel: "banner" | "modal" }[];
}

export interface RulesPayload {
  children: { id: string; displayName: string; timezone: string | null }[];
  policy_sets: {
    id: string;
    child_id: string;
    override_enabled: boolean;
    override_allowed_minutes: number[];
    override_caps: { max_minutes_per_day: number; max_grants_per_day: number };
    windows: RuleWindow[];
  }[];
}

export const getRules = () => call<RulesPayload>("/rules");

export const saveRules = (policySetId: string, windows: RuleWindow[]) =>
  call<{ saved: boolean }>("/rules", {
    method: "PUT",
    body: JSON.stringify({ policy_set_id: policySetId, windows }),
  });

export const getRulesDiff = (deviceId: string) =>
  call<{
    device_id: string;
    current_version: number | null;
    current_document: unknown;
    proposed_document: unknown;
    changed: boolean;
    /** ★ C3 — true ONLY for a tightening inside 15 minutes. */
    confirm_immediate_effect: boolean;
    confirm_reason: string | null;
  }>(`/rules/diff?device_id=${deviceId}`);

export const publishRules = (deviceId: string, confirmed: boolean) =>
  post<{ status: string; version?: number }>("/rules/publish", {
    device_id: deviceId,
    confirmed_immediate_effect: confirmed,
  });

export const getRulesHistory = (deviceId: string) =>
  call<{
    versions: {
      version: number;
      etag: string;
      document_hash: string;
      issued_at: string;
      reason: string | null;
      confirm_immediate_effect: boolean;
    }[];
  }>(`/rules/history?device_id=${deviceId}`);

export const restoreVersion = (deviceId: string, version: number) =>
  post<{ restored_from: number; status: string }>(
    `/rules/history/${version}/restore?device_id=${deviceId}`,
  );

export const getCalendar = () =>
  call<{
    exceptions: {
      id: string;
      childId: string | null;
      day: string;
      effect: string;
      extendMinutes: number | null;
      note: string | null;
    }[];
  }>("/rules/calendar");

export const upsertException = (input: {
  child_id: string;
  day: string;
  effect: "treat_as_weekend" | "no_bedtime" | "custom" | "dismiss_holiday";
  extend_minutes?: number;
  note?: string;
}) => post<{ saved: boolean; recompiled: number }>("/rules/calendar", input);

// ── Reports

export interface ReportPayload {
  request: { from: string; to: string; grain: "hour" | "day" };
  generatedAt: string;
  totals: { foregroundS: number; activeS: number; reportedBuckets: number; gapBuckets: number };
  buckets: {
    bucket: string;
    foregroundS: number;
    activeS: number;
    apps: { bundleId: string; foregroundS: number; activeS: number }[];
    /** ★ False means NO DATA, which is not the same as zero usage. */
    reported: boolean;
  }[];
  enforcement: { at: string; kind: string; summary: string; deviceId: string }[];
  gaps: { from: string; to: string | null; state: string; reason: string | null }[];
  labels: {
    children: { id: string; displayName: string }[];
    devices: { id: string; label: string | null; childId: string | null }[];
  };
}

export const getReports = (params: {
  grain?: "hour" | "day";
  device_id?: string;
  child_id?: string;
  from?: string;
  to?: string;
}) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }
  return call<ReportPayload>(`/reports?${query.toString()}`);
};

// ── Setup and settings

export const getSetup = () =>
  call<{
    children: { id: string; displayName: string; timezone: string | null }[];
    devices: { id: string; label: string | null; status: string; childId: string | null }[];
    pending_codes: {
      device_id: string;
      hint: string;
      expires_at: string;
      attempts: number;
      expired: boolean;
    }[];
    next_step: "add_child" | "add_device" | "enrol_device" | "done";
  }>("/setup");

export const createChild = (input: { display_name: string; timezone?: string }) =>
  post<{ child_id: string; policy_set_id: string | null }>("/children", input);

export const createDevice = (input: { child_id: string; label: string }) =>
  post<{ device_id: string; code: string; expires_at: string; ttl_minutes: number }>(
    "/devices",
    input,
  );

export const reissueCode = (deviceId: string) =>
  post<{ code: string; expires_at: string; ttl_minutes: number }>(
    `/devices/${deviceId}/enrolment-code`,
  );

export const getSettings = () =>
  call<{
    children: { id: string; displayName: string; timezone: string | null }[];
    policy_sets: {
      id: string;
      childId: string;
      overrideEnabled: boolean;
      overrideMaxMinutesPerDay: number;
      overrideMaxGrantsPerDay: number;
      telemetryEnabled: boolean;
    }[];
  }>("/settings");

export const patchSettings = (input: {
  policy_set_id: string;
  override_enabled?: boolean;
  override_max_minutes_per_day?: number;
  override_max_grants_per_day?: number;
  telemetry_enabled?: boolean;
}) => call<{ saved: boolean }>("/settings", { method: "PATCH", body: JSON.stringify(input) });
