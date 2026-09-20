---
name: zod-jsonschema-strict-default
description: z.toJSONSchema() emits additionalProperties:false by default, silently turning a tolerant zod schema into a strict reader for whoever consumes the artefact.
metadata:
  type: feedback
---

**When emitting JSON Schema from zod for another language to consume, pass
`{ io: "input" }` — or you ship a strict reader while believing you shipped a tolerant one.**

```ts
z.toJSONSchema(registry)                  // additionalProperties: false  ❌
z.toJSONSchema(registry, { io: "input" }) // additionalProperties absent  ✅
```

**Why it hides.** The zod schema stays tolerant the whole time — `z.object().parse()` strips unknown
keys exactly as intended, every TypeScript test passes, and nothing in the producing codebase is
wrong. The strictness only exists in the *derived artefact*, and it only bites in the *consuming*
language. In this project that consumer is a Swift agent running unattended on a machine in another
room: a decoder generated from `additionalProperties: false` rejects every field the server adds
later, which is precisely the failure the tolerant-reader rule (R1) exists to prevent.

Measured on zod 4.6.5:

| | `additionalProperties` | runtime |
|---|---|---|
| `z.object()` | **`false`** | strips unknowns |
| `z.object()` + `io: "input"` | absent | strips unknowns |
| `z.looseObject()` | `{}` | *keeps* unknowns |

Pick by which runtime you want; `z.object()` + `io: "input"` keeps stripping while emitting a
permissive artefact.

## Guard the effect, not the syntax

The instruction this came from asked for `.strict()` to be "banned by lint rule". Biome has no
`noRestrictedSyntax`, so a grep test was written instead — **and it failed by matching itself five
times.** Every hit was a comment or the test's own pattern string; there was no real call anywhere.

It was deleted rather than patched, because the better test already existed: walk the *emitted
artefact* and fail on any `additionalProperties: false`.

```ts
export function strictPaths(node: unknown, path = "$"): string[] { /* recurse */ }
expect(strictPaths(buildArtefact())).toEqual([]);
```

That catches `.strict()`, `.catchall(z.never())`, a bad emitter flag, or any future route to the
same place — and it recurses through everything reachable from the schema registry, which for a
wire contract is by definition everything that matters. **A test on the property you care about
beats a test on one way of violating it.**

See [[verify-macos-claims]] — same shape of mistake: the plausible check was not the one that
would have caught the problem.
