import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { getRateLimitKey } from "./rate-limit.js";

/** Runs the real function inside a real Hono request. */
async function keyFor(
  headers: Record<string, string> = {},
  user?: { id: string },
): Promise<string> {
  const app = new Hono<{ Variables: { user: { id: string } } }>();
  app.get("/", (c) => {
    if (user) c.set("user", user);
    return c.text(getRateLimitKey(c));
  });
  const res = await app.request("/", { headers });
  return res.text();
}

describe("getRateLimitKey", () => {
  it("prefers the api key — one bucket per enrolled device", async () => {
    // Keying on the raw header rather than a resolved session is what lets the
    // limiter run BEFORE auth.
    expect(await keyFor({ "x-api-key": "hpc_dk_abc" }, { id: "u1" })).toBe("key:hpc_dk_abc");
  });

  it("falls back to the session user", async () => {
    expect(await keyFor({}, { id: "u1" })).toBe("user:u1");
  });

  it("falls back to the forwarded IP, taking the first hop", async () => {
    // Behind Traefik the client address is the leftmost entry.
    expect(await keyFor({ "x-forwarded-for": "192.168.1.50, 10.42.0.1" })).toBe("ip:192.168.1.50");
    expect(await keyFor({ "x-real-ip": "192.168.1.51" })).toBe("ip:192.168.1.51");
  });

  it("degrades to a single shared bucket when nothing identifies the caller", async () => {
    expect(await keyFor()).toBe("ip:anon");
  });
});
