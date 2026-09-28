import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, withLogContext } from "./logger.js";

/**
 * The log line's SHAPE is a contract with Loki and every query written
 * against it, so it is tested by reading real JSON back. pino writes to fd 1
 * directly, so the trick (from llm-gateway) is the same options writing to a
 * captured stream.
 */
function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      for (const line of chunk.toString().split("\n").filter(Boolean)) lines.push(JSON.parse(line));
      done();
    },
  });
  return { lines, logger: createLogger(stream) };
}

describe("the log line", () => {
  it("★ writes the level as a WORD — Loki's detected_level needs it", () => {
    const { lines, logger } = capture();
    logger.info({ event: "a" }, "static");
    logger.warn({ event: "b" }, "static");
    logger.error({ event: "c" }, "static");
    expect(lines.map((line) => line.level)).toEqual(["info", "warn", "error"]);
  });

  it("carries the house fields: service, version, ISO time, event, msg", () => {
    const { lines, logger } = capture();
    logger.info({ event: "server.start" }, "api server listening");
    expect(lines[0]).toMatchObject({
      service: "hpc-api",
      event: "server.start",
      msg: "api server listening",
    });
    expect(String(lines[0]?.version)).toMatch(/^\d+\.\d+\.\d+/);
    expect(String(lines[0]?.time)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("★ never writes a device token, an enrolment code or the x-api-key header", () => {
    const { lines, logger } = capture();
    logger.info(
      {
        token: "hpc_dk_secret",
        credential: { token: "hpc_dk_secret" },
        code: "HPC-ABCD-EFGH-JKLM",
        headers: { "x-api-key": "hpc_dk_secret" },
      },
      "static",
    );
    const text = JSON.stringify(lines[0]);
    expect(text).not.toContain("hpc_dk_secret");
    expect(text).not.toContain("HPC-ABCD");
    expect(text).toContain("[redacted]");
  });

  it("★ adds the request's or job run's context to every line inside it, and only there", () => {
    const { lines, logger } = capture();
    withLogContext({ req_id: "r-1" }, () => logger.info({ event: "inside" }, "static"));
    withLogContext({ job: "projection", run_id: "run-1" }, () =>
      withLogContext({ step: "bucket" }, () => logger.info({ event: "nested" }, "static")),
    );
    logger.info({ event: "outside" }, "static");
    expect(lines[0]).toMatchObject({ event: "inside", req_id: "r-1" });
    expect(lines[1]).toMatchObject({ job: "projection", run_id: "run-1", step: "bucket" });
    expect(lines[2]).not.toHaveProperty("req_id");
  });

  it("serialises an Error under `err` with its stack", () => {
    const { lines, logger } = capture();
    logger.error({ event: "x", err: new Error("boom") }, "static");
    expect(lines[0]?.err).toMatchObject({ type: "Error", message: "boom" });
    expect(String((lines[0]?.err as { stack?: string } | undefined)?.stack)).toContain("boom");
  });
});
