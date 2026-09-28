import { describe, expect, it } from "vitest";
import { webErrorLine } from "./web-error-log.js";

const when = new Date("2026-09-28T19:00:00.000Z");
const route = { routePath: "/reports", routeType: "render" };

describe("the web's error line", () => {
  it("★ is ONE line of JSON in the house shape, with the level as a word", () => {
    const error = Object.assign(new Error("controller broke"), { digest: "3173815633" });
    const line = webErrorLine(error, { path: "/reports", method: "GET" }, route, when);
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toMatchObject({
      level: "error",
      time: "2026-09-28T19:00:00.000Z",
      service: "hpc-web",
      event: "web.request_error",
      method: "GET",
      path: "/reports",
      route: "/reports",
      digest: "3173815633",
      err: { type: "Error", message: "controller broke" },
      msg: "request failed",
    });
  });

  it("★ drops the query string and never carries headers", () => {
    const line = webErrorLine(
      new Error("x"),
      {
        path: "/devices/1?token=secret",
        method: "GET",
        headers: { cookie: "session=abc" },
      } as never,
      route,
      when,
    );
    expect(line).not.toContain("secret");
    expect(line).not.toContain("session=abc");
    expect(JSON.parse(line).path).toBe("/devices/1");
  });

  it("copes with something thrown that is not an Error", () => {
    const parsed = JSON.parse(
      webErrorLine("plain string", { path: "/", method: "GET" }, route, when),
    );
    expect(parsed.err.message).toBe("plain string");
  });
});
