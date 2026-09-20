import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildArtefact, strictPaths } from "./emit.js";
import { EVENT_ID_REGEX } from "./primitives.js";

const here = dirname(fileURLToPath(import.meta.url));
const artefactPath = join(here, "..", "contract.schema.json");

describe("R1 guard — the artefact must describe a TOLERANT reader", () => {
  it("contains no object that forbids unknown fields", () => {
    // Replaces the lint rule R1 asks for: biome has no noRestrictedSyntax, and
    // testing the EFFECT is strictly better than banning one syntax — this
    // catches .strict(), .catchall(z.never()), or any other route to the same
    // place. Without `io: "input"` the emitter produces these by default, so
    // this test is load-bearing, not decorative.
    const found = strictPaths(buildArtefact());
    expect(
      found,
      `strict objects would make the Swift agent reject new fields:\n${found.join("\n")}`,
    ).toEqual([]);
  });

  // A grep for `.strict(` was tried here and removed: it matched only comments
  // and its own pattern string, never a real call. The guard above is strictly
  // better anyway — it tests the EFFECT (does the artefact forbid unknown
  // fields?) rather than one syntax that could produce it, and `strictPaths`
  // recurses through everything reachable from the registry, which is by
  // definition everything on the wire.
});

describe("the emitted artefact", () => {
  it("names every schema the agent needs", () => {
    const { schemas } = buildArtefact() as { schemas: Record<string, unknown> };
    expect(Object.keys(schemas).sort()).toEqual(
      [
        "EnrolmentRequest",
        "EnrolmentResponse",
        "EventEnvelope",
        "EventsRequest",
        "EventsResponse",
        "PolicyDocument",
        "ProblemDocument",
        "ServerHealth",
        "SyncRequest",
        "SyncResponse",
      ].sort(),
    );
  });

  it("carries the exact UUIDv7 pattern through to the Swift side", () => {
    // The agent author generates a decoder from this file; if the pattern does
    // not survive emission, the two ends disagree about the idempotency key.
    expect(JSON.stringify(buildArtefact())).toContain(EVENT_ID_REGEX.source.replace(/\\/g, "\\\\"));
  });

  it("matches the committed contract.schema.json", () => {
    // Fails when a schema changed and the artefact was not regenerated.
    // Run: pnpm --filter @hpc/contract emit
    const committed = JSON.parse(readFileSync(artefactPath, "utf-8"));
    expect(committed).toEqual(buildArtefact());
  });
});
