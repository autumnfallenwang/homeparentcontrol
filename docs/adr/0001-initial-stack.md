# 0001 — Initial tech stack

- **Status:** accepted
- **Date:** 2026-09-18
- **Deciders:** project founder (captured during `/devkit-init`)

## Context

This is the founding stack decision for the project, recorded at scaffold time. It captures what we picked and why, so future contributors can understand the constraints in play when these choices were made.

The project enforces screen-time rules on a child's Mac and reports usage to a parent. Two prior proofs
of concept shaped the stack. POC 1 established that enforcement is achievable on macOS 26 with a root
LaunchDaemon and `osascript`, with no MDM, kernel extension or third-party dependency. POC 2 ran eight
research tracks over the architecture, contract, lifecycle, observability and prior art, then verified
the load-bearing claims by direct testing on the target OS.

Three constraints dominated. **Consistency:** the owner already runs four self-hosted apps on a
single-node k3s cluster with an established pattern (pnpm/turbo, Hono, Next.js, Drizzle, Postgres, Helm,
GHCR, Argo CD), and explicitly wanted this to meet that production standard rather than be a script in a
folder. **Cost:** the paid Apple Developer Program buys only Time Sensitive notifications, which the
child can revoke in two clicks and whose expiry would silently stop the agent launching — so ad-hoc
signing throughout, and monitoring deliberately kept to the permission-free tier that needs no TCC
grants. **Offline-first enforcement:** bedtime cannot depend on a cluster being up, which forced the
split between a networked sync daemon and an enforcement daemon that opens no socket at all.

Notably, the language choice was *not* forced by the OS. Research concluded across three tracks that
macOS 26's Background Task Management would leave a script-entry daemon disallowed after reboot; **direct
testing refuted this** — both a bash-entry and an ad-hoc Mach-O daemon returned `[enabled, allowed]`.
Swift was chosen on engineering merit, not necessity.

## Decision

- **Primary language:** typescript
- **Package manager:** pnpm

- **Control plane language:** TypeScript — matches the four sibling `home*` apps
- **Agent language:** Swift, ad-hoc signed (Go was runner-up; bash remains viable and POC 1 is not discarded)
- **Package manager:** pnpm, with turbo for the monorepo
- **API framework:** Hono · **Web framework:** Next.js + React + shadcn
- **ORM / database:** Drizzle ORM on Postgres · **Auth:** better-auth, with device keys on a per-household service user
- **Lint:** biome (TypeScript), swiftlint (Swift) · **Test:** vitest, xctest · **Typecheck:** tsc, swiftc
- **Deploy:** Helm chart → single-node k3s, GitHub Actions → GHCR → tag bump in `arch-infra` → Argo CD
- **Observability:** structured JSON on stdout → control plane → existing Loki/Grafana
- **Agent delivery:** signed `.pkg` via GitHub Releases, version pinned in the GitOps repo
- **Enforcement:** lock → 300 s grace → shutdown · **Override:** online one-click grant only
- **Monitoring tier:** permission-free only — app identity, CPU-gated `active_s`, idle, power/session

## Consequences

**Positive**

- The control plane is the fifth app in an established pattern, so most of it is already-solved work —
  the Helm chart shape, the GHCR→Argo chain, migrations, auth and the observability stack all carry over.
  Research confirmed the deltas fit a single table.
- The free-tier monitoring decision removes the entire TCC surface: no grants, no Team ID, no $99, and
  nothing breaks when the agent updates.
- Choosing online-only overrides removed roughly a quarter of the planned schema — three tables, six
  columns, the offline card and its whole reconciliation problem.
- The enforcer having no network code makes offline enforcement a structural property that cannot be
  regressed by a careless change, rather than a promise in a comment.

**Negative**

- Swift is a second toolchain and appears nowhere else in the owner's stack. Two languages means two
  lint/test/typecheck paths in one repo.
- The agent cannot be deployed the way everything else is. It needs its own `.pkg` and GitHub Releases
  path, bolted to the GitOps chain by a version pin rather than reconciled directly.
- Ad-hoc signing means TCC grants can never be relied on — an ad-hoc binary's designated requirement is
  its exact `cdhash`, and even a no-op rebuild changes it. Any future richer monitoring requires buying
  the $99 *and* revisiting signing.
- Deferring offline override codes means that if k3s is down at bedtime specifically, no extra time can
  be granted that night.

**Open risks**

- ⚠️ Every empirical finding is macOS 26.6.2. macOS 27 shipped four days before this ADR and is untested.
  **Five of six audited documentation-derived claims turned out wrong, partly wrong or unverifiable**, so
  version-fragile conclusions should be treated as hypotheses until observed.
- `.pkg` downgrade was observed only in the user domain; the rollback story depends on the system domain
  behaving the same way (**V-PKG-1**).
- The enforcement-isolation matrix (V1–V9) is unbuilt, and it is the contract's central unproven claim.
- POC 1 found both of its bugs in the enforcement path, and its dry-run suite caught neither. That path
  needs testing live against the clock.

## Notes

- This ADR can be **superseded** by a later ADR if the stack changes substantially. Do not edit this file's Decision section — write a new ADR and mark the status here as `superseded by NNNN`.
- Subsequent decisions about architecture, libraries, or deployment go in their own numbered ADRs.
