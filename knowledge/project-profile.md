---
name: project-profile
description: Seeded by /devkit-init on 2026-09-18. Captures who this project is and what shape it has.
metadata:
  type: project
---

# homeparentcontrol

Self-hosted parental control for a child's Mac: a headless Swift agent enforces screen-time rules on the target machine, and a k3s-deployed web app gives the parent rules, monitoring and reporting.

## What this project is

A parent needs their child's Mac mini to stop being usable past bedtime, and wants to see how it was
used. Apple's Screen Time cannot power a machine off, exposes no supported API on macOS for a third party
to build against, and does not report the way this household wants — so the enforcement and reporting are
custom. The consumer is a single parent, through an internal web UI reached from a browser on the home
network; there is never a mobile app, and never any UI the child can open. The defining constraint is
that **enforcement must not depend on the network**: bedtime happens whether or not the k3s cluster is
up, which is why the enforcement daemon has no network code at all. One child and one Mac today, built so
a second of either is not a rewrite.

## Stack at a glance

- **Primary language:** typescript
- **Package manager:** pnpm

- **Agent language:** Swift, ad-hoc signed — two root LaunchDaemons plus an update supervisor
- **API:** Hono · **Web:** Next.js + React + shadcn · **Monorepo:** turbo
- **Database:** Postgres via Drizzle ORM · **Auth:** better-auth (device keys on a service user)
- **Lint:** biome / swiftlint · **Test:** vitest / xctest · **Typecheck:** tsc / swiftc
- **Deploy target:** single-node k3s on `aaron-desktop-arch`, via Helm + Argo CD
- **CI/CD:** GitHub Actions → GHCR → image-tag bump in the `arch-infra` GitOps repo
- **Observability:** structured JSON stdout → control plane → existing Loki + Grafana
- **Agent delivery:** signed `.pkg` on GitHub Releases, version pinned in GitOps
- **Target platform:** Apple Silicon, macOS 26.6.2 (macOS 27 untested)

## Why future-you should keep this entry up to date

This is `type: project`, meaning it's a live cache of project-level context — not history. As the project evolves (new components, removed deps, shifted scope), update this file. Delete it entirely if the project changes shape so fundamentally that the brainstorm answers no longer apply, and capture a fresh one.
