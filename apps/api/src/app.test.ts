import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

describe("createApp", () => {
  it("serves GET /health", async () => {
    const res = await createApp().request("/health");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok" });
  });

  it("404s an unknown path rather than throwing", async () => {
    const res = await createApp().request("/nope");
    expect(res.status).toBe(404);
  });
});
