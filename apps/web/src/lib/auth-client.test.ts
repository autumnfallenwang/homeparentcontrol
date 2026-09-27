import { afterEach, describe, expect, it, vi } from "vitest";
import { signOut } from "./auth-client.js";

describe("signOut", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("★ sends a JSON content type — better-auth answers a bare POST with 415", async () => {
    const fetch = vi.fn(async () => new Response('{"success":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await signOut();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/auth\/sign-out$/);
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(init.credentials).toBe("include");
  });

  it("throws when the server refuses, so the button can say so", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 415 })),
    );
    await expect(signOut()).rejects.toThrow();
  });
});
