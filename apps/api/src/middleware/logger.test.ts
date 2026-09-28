import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { log } from "../lib/logger.js";

/** Every `http.request` line the app logs, with its level. */
function requestLines() {
  const lines: { level: string; fields: Record<string, unknown> }[] = [];
  for (const level of ["info", "warn", "error"] as const) {
    vi.spyOn(log, level).mockImplementation(((fields: Record<string, unknown>) => {
      if (fields?.event === "http.request") lines.push({ level, fields });
    }) as never);
  }
  return lines;
}

afterEach(() => vi.restoreAllMocks());

describe("the request log", () => {
  it("★ a healthy /health is not logged — the probes were 30% of all lines", async () => {
    const lines = requestLines();
    const res = await createApp().request("/health");
    expect(res.status).toBe(200);
    expect(lines).toEqual([]);
  });

  it("a 4xx is logged at warn, in the house shape", async () => {
    const lines = requestLines();
    await createApp().request("/nope");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe("warn");
    expect(lines[0]?.fields).toMatchObject({ method: "GET", path: "/nope", status: 404 });
    expect(lines[0]?.fields.latency_ms).toBeTypeOf("number");
  });

  it("★ a thrown error is a flat 500 and ONE error line carrying the stack", async () => {
    const lines = requestLines();
    const app = createApp();
    app.get("/boom", () => {
      throw new Error("kaboom");
    });
    const res = await app.request("/boom");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe("error");
    expect((lines[0]?.fields.err as Error | undefined)?.message).toBe("kaboom");
  });

  it("★ echoes a well-formed X-Request-Id and uses it as req_id", async () => {
    const lines = requestLines();
    const res = await createApp().request("/nope", { headers: { "x-request-id": "trace-123" } });
    expect(res.headers.get("x-request-id")).toBe("trace-123");
    expect(lines[0]?.fields.req_id).toBe("trace-123");
  });

  it("★ replaces a malformed one rather than writing free text into Loki", async () => {
    const lines = requestLines();
    const res = await createApp().request("/nope", {
      headers: { "x-request-id": 'bad id"} {"level":"fatal' },
    });
    const id = res.headers.get("x-request-id") ?? "";
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(lines[0]?.fields.req_id).toBe(id);
  });

  it("★ the agent routes keep their own problem+json — the global handler swallows nothing", async () => {
    const res = await createApp().request("/api/agent/v1/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
  });
});
