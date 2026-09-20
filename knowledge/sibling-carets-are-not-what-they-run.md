---
name: sibling-carets-are-not-what-they-run
description: A caret range in a sibling repo's package.json is not the version that sibling runs — read its lockfile before copying code written against it.
metadata:
  type: feedback
---

**Before copying code from `homecal`, `homework` or `homenews`, read the version out of their
`pnpm-lock.yaml`, not their `package.json`.**

```bash
gh api repos/autumnfallenwang/<repo>/contents/pnpm-lock.yaml --jq '.content' \
  | base64 -d | grep -A1 "^  <package>@"
```

A caret says *"anything up to the next major"*. The lockfile says what actually runs. When the
sibling's code was written a year ago, those are different libraries — and the sibling keeps working
because **its** lockfile is frozen, while a fresh install in a **new** repo silently resolves to
something else.

## It has bitten twice, in consecutive tasks

| | Manifest | Sibling actually runs | We resolved | Damage |
|---|---|---|---|---|
| **biome** | `^2.4.4` | 2.4.x | **2.5.14** | `linter.recommended` deprecated in favour of `preset` — a warning on every lint run |
| **better-auth** | `^1.4.19` | **1.4.19** | **1.7.5** | apiKey plugin **moved to a separate package**, and the `apikeys` table gained a required `configId` column. Minting a key failed outright |

The better-auth case is the instructive one. `homecal`'s auth is the thing the spec says to take
*wholesale* — its X2 rate-limit carve-out, its service-account flow, its scar comments. All of it is
written against 1.4.x. On 1.7.5 the import path is wrong, the schema is wrong, and none of the
lessons transfer. **We would have been porting while believing we were copying.**

## How to apply

- **Reading a sibling for conventions?** `gh api` its source (see [[read-siblings-via-gh]]).
- **Copying code that calls a library?** Read its lockfile and pin that version **exactly, without a
  caret**. The caret is the bug; it is what let the drift happen in the first place.
- An upgrade then becomes a deliberate task with its own testing, rather than something a stray
  `pnpm update` inflicts at the worst moment.

This does not contradict "take the newer of the two siblings" for ordinary dependencies. It applies
specifically where **we are copying code written against a particular API** — there, matching the
sibling is the whole point.
