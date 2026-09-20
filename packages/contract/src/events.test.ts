import { describe, expect, it } from "vitest";
import { eventEnvelope, eventsRequest } from "./events.js";

const base = {
  event_id: "018f2a4e-0011-7a2b-8c3d-4e5f6a7b8c9d",
  type: "app.usage_sample",
  v: 1,
  class: "sample" as const,
  ts: "2026-09-18T20:26:00.000Z",
  seq: 41205,
  data: { bundle_id: "com.apple.Safari", foreground_s: 60, active_s: 47, cpu_pct_avg: 3.1 },
};

describe("event envelope — R8", () => {
  it("parses the spec's example verbatim", () => {
    expect(eventEnvelope.parse(base).type).toBe("app.usage_sample");
  });

  it("ACCEPTS an unknown event type — never rejected, stored verbatim", () => {
    // This is what makes D.1 and D.2 safe to defer: adding per-app reporting
    // later is a backfill, not a migration.
    expect(eventEnvelope.parse({ ...base, type: "something.invented.in.2027" }).type).toBe(
      "something.invented.in.2027",
    );
  });

  it("treats data as opaque — the transport knows nothing about it", () => {
    const out = eventEnvelope.parse({ ...base, data: { anything: { nested: [1, 2, 3] } } });
    expect(out.data).toEqual({ anything: { nested: [1, 2, 3] } });
  });

  it("strips unknown envelope keys rather than rejecting — R1", () => {
    const out = eventEnvelope.parse({ ...base, future_envelope_field: "x" });
    expect("future_envelope_field" in out).toBe(false);
  });

  it("rejects a class outside sample|audit", () => {
    expect(eventEnvelope.safeParse({ ...base, class: "debug" }).success).toBe(false);
  });

  it("rejects a malformed event_id — the idempotency key must be exact", () => {
    expect(eventEnvelope.safeParse({ ...base, event_id: "not-a-uuid" }).success).toBe(false);
  });
});

describe("events request", () => {
  it("carries device_id and boot_id on the batch, not the event", () => {
    const req = eventsRequest.parse({
      contract: 1,
      device_id: "018f2a4c-7b31-7c9e-9d2a-3f5b7c1e4a60",
      boot_id: "018f2a4c-9d53-7e2a-b4c9-6f8e0a3d5c72",
      events: [base],
    });
    expect(req.events).toHaveLength(1);
    expect("device_id" in req.events[0]!).toBe(false);
  });
});
