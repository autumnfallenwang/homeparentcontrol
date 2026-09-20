// Wire-format contract shared by the API and — via a JSON-Schema artefact emitted
// in CI — the Swift agent. Barrel; consumers import from "@hpc/contract".
//
// R9: nothing on this boundary is a database row. These schemas are hand-written
// zod, never generated from Drizzle. Keeping them here is what stops "the payload
// evolves later" from becoming "every payload change is a migration".
//
// R1: never call .strict() on anything in this package. Both ends must tolerate
// unknown fields — zod's .parse() already strips them. Enforced by emit.test.ts,
// not by a lint rule: biome has no noRestrictedSyntax.

export * from "./emit.js";
export * from "./enrolment.js";
export * from "./events.js";
export * from "./policy.js";
export * from "./primitives.js";
export * from "./problem.js";
export * from "./registry.js";
export * from "./sync.js";
export * from "./telemetry.js";
export * from "./version.js";
// ⚠️ Not a wire schema. The four load-bearing wordings live here because they
// are consumed by two sides and must not drift — see the header of
// `wording.ts`. They are deliberately NOT part of the JSON-Schema artefact;
// `emit.ts` enumerates what it emits, so nothing here reaches the agent.
export * from "./wording.js";
