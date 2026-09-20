import { ACTION_BY_STATUS, HALTING_ACTION, problemDocument } from "@hpc/contract";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  PRE_CREDENTIAL_PROBLEMS,
  PROBLEM_BASE,
  PROBLEMS,
  type ProblemKey,
  problem,
} from "./problem.js";

/** Runs `problem()` inside a real request so `instance` and headers are real. */
async function emit(key: ProblemKey, path = "/api/agent/v1/sync") {
  const app = new Hono();
  app.all("*", (c) => problem(c, key));
  const res = await app.request(path, { method: "GET" });
  return { res, body: (await res.json()) as Record<string, unknown> };
}

const ALL_KEYS = Object.keys(PROBLEMS) as ProblemKey[];

describe("the problem registry", () => {
  it("emits documents the contract accepts", async () => {
    for (const key of ALL_KEYS) {
      const { body } = await emit(key);
      expect(problemDocument.safeParse(body).success, key).toBe(true);
    }
  });

  it("roots every type at the API host, not the UI's", async () => {
    // §4.7's only example points at hpc.arch.internal, which is the Next.js
    // parent UI. The thing emitting these is the API.
    for (const key of ALL_KEYS) {
      const { body } = await emit(key);
      expect(String(body.type).startsWith(`${PROBLEM_BASE}/`), key).toBe(true);
      expect(String(body.type)).not.toContain("//hpc.arch.internal");
    }
  });

  it("uses a distinct slug per problem", () => {
    const slugs = ALL_KEYS.map((k) => PROBLEMS[k].slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("sets the RFC 9457 media type and the real status", async () => {
    const { res, body } = await emit("scopeViolation");
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(body.status).toBe(403);
  });

  it("puts the request path in `instance`", async () => {
    const { body } = await emit("policyNotFound", "/api/agent/v1/policy");
    expect(body.instance).toBe("/api/agent/v1/policy");
  });

  it("carries the contract's action for authenticated statuses", async () => {
    expect((await emit("unauthorized")).body.hpc_action).toBe(ACTION_BY_STATUS[401]);
    expect((await emit("scopeViolation")).body.hpc_action).toBe(ACTION_BY_STATUS[403]);
    expect((await emit("rateLimited")).body.hpc_action).toBe(ACTION_BY_STATUS[429]);
  });

  it("omits the action when asked", async () => {
    const app = new Hono();
    app.all("*", (c) => problem(c, "unauthorized", { action: null }));
    const body = (await (await app.request("/x")).json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("hpc_action");
  });
});

/**
 * ★ The guard. §4.7's table is global — 410 means `decommission`, the one
 * action that stops enforcement — while §5.5 uses 410 on /enroll for an
 * expired code, and /enroll is the only unauthenticated endpoint in the
 * system. Read literally, the single wire signal that stops enforcement is
 * reachable with no credential.
 */
describe("pre-credential responses can never stop enforcement", () => {
  it("no pre-credential problem carries any hpc_action at all", async () => {
    for (const key of PRE_CREDENTIAL_PROBLEMS) {
      const { body } = await emit(key, "/api/agent/v1/enroll");
      expect(body, key).not.toHaveProperty("hpc_action");
    }
  });

  it("the 410 that /enroll emits is NOT decommission", async () => {
    const { res, body } = await emit("enrolCodeExpired", "/api/agent/v1/enroll");
    expect(res.status).toBe(410);
    expect(ACTION_BY_STATUS[410]).toBe(HALTING_ACTION); // the table really does say this
    expect(body.hpc_action).toBeUndefined(); // and we really do not send it
  });

  it("the 409 that /enroll emits is NOT reenroll", async () => {
    // Harmless but meaningless: there is no credential to re-enrol with yet.
    const { body } = await emit("enrolCodeConsumed", "/api/agent/v1/enroll");
    expect(body.hpc_action).toBeUndefined();
  });

  it("NO problem in the whole registry emits decommission", async () => {
    // Decommission is parent-initiated and authenticated (§4.7). Nothing this
    // server can throw should ever produce it; the future decommission route
    // must construct it deliberately, not inherit it from a status.
    for (const key of ALL_KEYS) {
      const { body } = await emit(key);
      expect(body.hpc_action, key).not.toBe(HALTING_ACTION);
    }
  });

  it("every pre-credential problem is a 4xx that cannot be confused with a revoked key", async () => {
    // §5.4: "A bad code is a 404/400, never a 401."
    for (const key of PRE_CREDENTIAL_PROBLEMS) {
      const { res } = await emit(key, "/api/agent/v1/enroll");
      expect(res.status, key).not.toBe(401);
      expect(res.status, key).toBeGreaterThanOrEqual(400);
      expect(res.status, key).toBeLessThan(500);
    }
  });
});
