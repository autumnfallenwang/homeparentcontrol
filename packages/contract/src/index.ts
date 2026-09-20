// Wire-format contract shared by the API and — via a JSON-Schema artefact emitted
// in CI — the Swift agent. Barrel; consumers import from "@hpc/contract".
//
// R9: nothing on this boundary is a database row. These schemas are hand-written
// zod, never generated from Drizzle. Keeping them here is what stops "the payload
// evolves later" from becoming "every payload change is a migration".
//
// R1: never call .strict() on anything in this package. Both ends must tolerate
// unknown fields — zod's .parse() already strips them.

export * from "./version.js";
