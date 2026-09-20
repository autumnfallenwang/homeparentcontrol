# homeparentcontrol

Self-hosted parental control for a child's Mac: a headless Swift agent enforces screen-time rules on the target machine, and a k3s-deployed web app gives the parent rules, monitoring and reporting.

## Stack

- **Primary language:** typescript
- **Package manager:** pnpm

## Commands

Day-to-day work runs through the `claude-devkit` skills at `.claude/skills/devkit-*`. Invoke them by name:

- **`/devkit-task`** — the daily workhorse: read context, plan, gate on user approval, implement, run the check loop.
- **`/devkit-commit`** — wrap up a work cycle: inspect diff, draft commit message, optionally capture knowledge / update milestone, commit.

Verification skills are invoked as sub-skills of `/devkit-task`, but you can also call them directly with natural language:

- "lint" / "fix the lint" → `devkit-lint`
- "typecheck" → `devkit-typecheck`
- "run the tests" / "fast tests" → `devkit-test`

## Structure

The build has not started; what exists today is the design record. `docs/` holds
[`requirements.md`](docs/requirements.md) (source-tagged needs), [`design-decisions.md`](docs/design-decisions.md)
(**the buildable spec — start here**), `architecture.md`, `adr/` and `research/` (the POC-2 record and
eight research tracks). `tools/verify/` holds the throwaway macOS probes used to settle the empirical
questions. The build adds `apps/api` (Hono) and `apps/web` (Next.js) for the control plane,
`deploy/chart` for the Helm chart Argo CD reconciles, and `agent/` for the Swift LaunchDaemons that run
on the child's Mac.

## Working with this repo

This project uses **milestone-driven** development:

- **One milestone at a time.** Milestones live in `docs/milestones/NN-*.md`. The full roadmap is
  written up front: `status: planned` → `open` → `awaiting-verification` → `done`, and **exactly one
  file is `open`**. The active milestone is the lowest-numbered `open` file — it holds the current
  scope, exit criteria and progress notes.
  - ⚠️ **`awaiting-verification` was added in milestone 04**, because M2 and M3 were both `open` at
    once and neither had any code left to write. Everything checkable without root was checked;
    what remained needed a Mac someone was willing to have locked. Leaving them `open` made the
    one-file rule meaningless and hid which milestone was actually being worked on. A milestone is
    `awaiting-verification` when its code is complete and its remaining exit criteria are *observations*
    a person has to make — and the file must say exactly which, with a procedure.
- **Plan before code.** `/devkit-task`'s Phase 3 plan-approval gate is non-negotiable, even for one-line fixes. The plan loop catches misunderstandings before they cost real time.
- **Verify before claiming done.** `/devkit-task` runs lint → typecheck → test before reporting success. Retry up to 3x on failure, then surface.
- **Architecture changes need an ADR.** If a significant decision was made (lib choice, boundary move, approach pivot), write a new `docs/adr/NNNN-*.md` from `docs/adr/0000-template.md`.
- **Knowledge is the team-shared memory.** `knowledge/<slug>.md` holds atomic facts, lessons, corrections, references. Capture via natural language ("remember this") or `/devkit-knowledge-capture`. Index at `knowledge/KNOWLEDGE.md`.

### Which file does this go in?

When something needs recording, walk down in order:

1. **A decision** (we chose A over B for reason R) → new ADR.
2. **What we're currently building** (this milestone's scope/plan/notes) → the active `docs/milestones/NN-*.md`.
3. **A change to the system's shape** (components, boundaries) → edit `docs/architecture.md` in place.
4. **A small correction or preference** the agent should remember → new knowledge entry, `type=feedback`.
5. **Non-code project context** (deadlines, constraints, stakeholders) → new knowledge entry, `type=project`.
6. **A URL / ticket / dashboard pointer** → new knowledge entry, `type=reference`.
7. **None of the above** → it probably doesn't need recording.

## Docs

- [`docs/architecture.md`](docs/architecture.md) — current system shape
- [`docs/adr/`](docs/adr/) — append-only decision history
- [`docs/milestones/`](docs/milestones/) — work plans + progress notes
- [`knowledge/KNOWLEDGE.md`](knowledge/KNOWLEDGE.md) — team-shared knowledge index

@knowledge/KNOWLEDGE.md
