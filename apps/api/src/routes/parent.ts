import { Hono } from "hono";
import { requireAuth } from "../middleware/auth.js";
import { type ParentVariables, withHousehold } from "./parent-context.js";
import {
  handleAttend,
  handleAway,
  handleDecommission,
  handleDevice,
  handleRevoke,
  handleSoak,
} from "./parent-devices.js";
import {
  handleGrantOverride,
  handleListOverrides,
  handleRevokeOverride,
} from "./parent-overrides.js";
import { handleReports } from "./parent-reports.js";
import {
  handleGetCalendar,
  handleGetRules,
  handlePublishRules,
  handleRestoreVersion,
  handleRulesDiff,
  handleRulesHistory,
  handleSaveRules,
  handleUpsertException,
} from "./parent-rules.js";
import {
  handleCreateChild,
  handleCreateDevice,
  handleGetSettings,
  handleListDevices,
  handlePatchSettings,
  handleReissueCode,
  handleSetupState,
} from "./parent-setup.js";
import { handleToday } from "./parent-today.js";

/**
 * The parent's half of the API, mounted at `/api/parent/v1`.
 *
 * Error shape here is the house's flat `{ error }`, hand-mapped per route.
 * ⚠️ Do NOT add a global `onError` to the root app — it would swallow those.
 * The agent sub-app gets its own scoped handler instead (§5.8).
 *
 * ⚠️ **Every route is household-scoped by `withHousehold`**, derived from the
 * signed-in user's membership — never from anything in the request. One
 * household exists today, which is exactly why the scoping has to be
 * structural now: the bug is unreachable until the moment it is catastrophic.
 *
 * ⚠️ **What is deliberately absent, with no route to add later**: any
 * child-facing surface (no login, no status page, no time-remaining widget,
 * no request button), and any "disable enforcement" verb in any spelling.
 * The nearest legal action is `POST /overrides` with `type: "suspend"` —
 * *"No bedtime tonight"*, which still carries a mandatory expiry.
 */
export const parentApp = new Hono<{ Variables: ParentVariables }>();

parentApp.use("*", requireAuth);
parentApp.use("*", withHousehold);

// ── `/` — the page that carries the product.
parentApp.get("/today", handleToday);

// ── `/devices/[id]`
parentApp.get("/devices", handleListDevices);
parentApp.post("/devices", handleCreateDevice);
parentApp.get("/devices/:id", handleDevice);
// ⚠️ A POST, not a GET side effect — a prefetch must not put a device into
// 5-second polling. See `handleAttend`.
parentApp.post("/devices/:id/attend", handleAttend);
parentApp.post("/devices/:id/away", handleAway);
// §6.5's shadow-mode soak. Read-only — it cannot extend a soak.
parentApp.get("/devices/:id/soak", handleSoak);
parentApp.post("/devices/:id/enrolment-code", handleReissueCode);
// ⚠️ These two look alike and behave oppositely (§5.5). Both require a typed
// confirmation, checked on the SERVER.
parentApp.post("/devices/:id/revoke", handleRevoke);
parentApp.post("/devices/:id/decommission", handleDecommission);

// ── `/override`
parentApp.get("/overrides", handleListOverrides);
parentApp.post("/overrides", handleGrantOverride);
parentApp.delete("/overrides/:id", handleRevokeOverride);

// ── `/rules`, `/rules/calendar`, `/rules/history`
parentApp.get("/rules", handleGetRules);
parentApp.put("/rules", handleSaveRules);
parentApp.get("/rules/diff", handleRulesDiff);
parentApp.post("/rules/publish", handlePublishRules);
parentApp.get("/rules/calendar", handleGetCalendar);
parentApp.post("/rules/calendar", handleUpsertException);
parentApp.get("/rules/history", handleRulesHistory);
// ⚠️ Restore publishes a NEW version with the old content. It never mutates
// history — `git revert` applied to bedtime.
parentApp.post("/rules/history/:version/restore", handleRestoreVersion);

// ── `/reports` — D.2's on-demand sink, sharing one query service.
parentApp.get("/reports", handleReports);

// ── `/settings`, `/setup`
parentApp.get("/settings", handleGetSettings);
parentApp.patch("/settings", handlePatchSettings);
parentApp.get("/setup", handleSetupState);
parentApp.post("/children", handleCreateChild);
