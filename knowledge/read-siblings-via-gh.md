---
name: read-siblings-via-gh
description: Read homework/homecal/arch-infra through `gh api`, never from the local clones on this Mac — they are months stale.
metadata:
  type: feedback
---

**When referencing a sibling app's conventions, read it with `gh api`, not from `~/github/`.**

```bash
gh api "repos/autumnfallenwang/homework/git/trees/HEAD?recursive=1" --jq '.tree[].path'
gh api repos/autumnfallenwang/homecal/contents/apps/api/src/auth.ts --jq '.content' | base64 -d
```

(Quote the URL — zsh globs `?`.)

**Why:** `~/github/homecal` and `~/github/homenews` exist on this Mac but their `origin/main` refs
were last updated **2026-03-30** and **2026-03-20**. The owner works almost entirely on the Arch
desktop, so the Mac clones are read-only leftovers. `homework` and `arch-infra` are not cloned here
at all.

During phase 0 this mattered concretely: the local `homecal` predates the **entire Phase 16/17
service-account and `x-api-key` system** that this project's device agent depends on, plus the
Phase 19 k3s cutover and the `COOKIE_DOMAIN` work. Scaffolding against it would have produced an
auth design for a codebase that no longer exists.

**How to apply:** `gh api …/contents/…` with no `?ref=` resolves to the default branch's HEAD, which
is always current. Record the commit you read against when it matters — phase 0 was built against
`homework@137b16b` and `homecal@3280fe3`.

The failure direction is **remote behind local**, not the reverse: the owner rarely commits from the
Mac, so an unpushed local commit is unlikely. Both clones were clean and `ahead=0` when checked.
