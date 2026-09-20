import type { Context } from "hono";
import { z } from "zod";
import { type Grain, reportQuery, scopeLabels } from "../lib/report-query.js";
import { fail, type ParentVariables } from "./parent-context.js";

/**
 * `GET /api/parent/v1/reports` — D.2's **on-demand** sink.
 *
 * ⚠️ The dashboard, the digest and any future alert all call the same
 * `reportQuery`. This route adds argument parsing and nothing else, which is
 * the whole point: "choosing a delivery mode later is a config flag and one
 * adapter, never a schema migration or a second query implementation that
 * drifts."
 */

const query = z.object({
  child_id: z.uuid().optional(),
  device_id: z.uuid().optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  grain: z.enum(["hour", "day"]).default("day"),
  top_apps: z.coerce.number().int().min(1).max(50).optional(),
});

/** A week of days, or a day of hours — whichever the grain implies. */
const DEFAULT_SPAN_MS: Record<Grain, number> = {
  day: 7 * 86_400_000,
  hour: 86_400_000,
};

export async function handleReports(c: Context<{ Variables: ParentVariables }>) {
  const householdId = c.get("householdId");
  const parsed = query.safeParse(c.req.query());
  if (!parsed.success) return fail(c, 400, "malformed report query");
  const args = parsed.data;

  const to = args.to ? new Date(args.to) : new Date();
  const from = args.from
    ? new Date(args.from)
    : new Date(to.getTime() - DEFAULT_SPAN_MS[args.grain]);

  if (from >= to) return fail(c, 422, "`from` must be before `to`");
  // ⚠️ A bound, because the payload is materialised in memory and an
  // unbounded range over hourly grain is 8,760 buckets per year per device.
  const maxSpanMs = args.grain === "hour" ? 31 * 86_400_000 : 400 * 86_400_000;
  if (to.getTime() - from.getTime() > maxSpanMs) {
    return fail(c, 422, `that range is too wide for ${args.grain} grain`);
  }

  const payload = await reportQuery({
    householdId,
    childId: args.child_id,
    deviceId: args.device_id,
    from,
    to,
    grain: args.grain,
    topApps: args.top_apps,
  });

  // Labels travel with the payload so a STORED digest renders without
  // re-resolving names that may have changed since. §5.8: "a stored digest
  // renders from its stored payload, never by re-running the query".
  const labels = await scopeLabels(householdId);

  return c.json({ ...payload, labels });
}
