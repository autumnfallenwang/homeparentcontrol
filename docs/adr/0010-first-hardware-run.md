# 0010 — What the first on-hardware smoke test changed

- **Status:** accepted
- **Date:** 2026-09-26
- **Deciders:** Aaron Wang

## Context

On 2026-09-22 the agent was installed on a real Mac and pointed at the deployed cluster for the first
time. It took two days to reach an enrolled, ticking agent, and the screen never locked. None of the
problems were in the enforcement logic. Every one was in the stretch between "the code is correct"
and "it runs on a Mac under launchd, driven from a browser" — the stretch that 405 API tests, 258
Swift tests and 9 end-to-end tests could not see, because all of them call the API directly and none
of them go through `installer`, launchd, SIP or a browser.

Five of the fixes needed a decision rather than a patch. They are recorded here together because they
share a cause and should be read together.

## Decision

**1. The supervisor is loaded once at first install.** `postinstall` bootstraps `com.hpc.supervisor`
only when `launchctl print` says launchd has never heard of it. It still never boots it out or
restarts it. A.24 ("the supervisor never self-updates") is about *replacing a running supervisor*; a
first install has no running supervisor to replace. Before this, `install.sh` checked all three jobs
while `postinstall` loaded two, so every first install failed — and on upgrades, where it was already
loaded, nobody noticed.

**2. The base URL is a file, `/var/db/homeparentcontrol/base_url`.** `install.sh --base-url` writes it;
the sync daemon re-reads it every tick; `$HPC_BASE_URL` still overrides it for running a binary by
hand. The two documented routes both failed: `launchctl setenv` is refused in the system domain under
SIP, and a URL edited into the installed plist is silently reset by the next pkg upgrade, which
reinstalls the plist from the payload — a Mac that quietly stops reporting after its first automatic
update. The packaged plist no longer carries a placeholder URL. The old fallback, `base_url` in
`device.json`, could never fire: nothing wrote it, and the placeholder always won.

**3. A rejected enrolment code is terminal.** `/enroll` answers a dead code with exactly 400, 404,
409 or 410 (`lib/problem.ts`); `EnrolmentPolicy` treats those as "stop sending this code", moves it to
`enrolment_code.rejected`, and waits for a new one at base cadence. 429 honours `Retry-After`; no
answer or a 5xx keeps ordinary backoff. The run's expired code was retried four times in five seconds,
the server burned it as abuse, the burned code was retried until the 20-per-hour **global** limiter was
exhausted, and no Mac in the household could enrol for an hour. This decides retrying *enrolment* only
— a 410 here is never `decommission` (A.7), and nothing in the path can stop enforcement.

**4. `seq = -1` means "not in the enforcer's sequence", and an absent `seq` reads as -1.** The
contract required a non-negative `seq` that three writers could never send: the deadfall sends -1 on
purpose, and the sync daemon's own samples and audits carry none. 39 of the run's 83 events were
dropped — including exactly the "which process locked this Mac" records the deadfall exists to
leave. The reader relaxes (R1), so agents already installed start landing without an upgrade. Gap
detection applies to `seq >= 0`; the projector breaks ties on `ts`. Giving the sync daemon its own
persisted per-boot counter is the follow-up if its events ever need clock-independent order.

**5. The `-dev` suffix comes from the compile flag, and every tool checks the binary.**
`AgentVersion.current` appends `-dev` under `DEV_ENFORCEMENT`, the flag that turns shutdown into a log
line, so a binary cannot misreport its variant. `build-pkg.sh` refuses a version argument that
disagrees with `AgentVersion.base` and refuses to package binaries whose `--version` disagrees with
the pkg. `install.sh` expands the pkg, asks the packaged enforcer, and refuses a pkg whose filename
contradicts it. Before, four daemons each hard-coded `"0.1.0"` and the suffix reached only the pkg:
the safe build reported the same version as production, so the device card's promised tell did not
exist.

## Consequences

- One command installs, points at the cluster and enrols (`install.sh <pkg> --base-url … --code …`).
  Nothing has to be restarted, and nothing depends on remembering an order.
- Every enrolment outcome now writes `sync.health` (`awaiting_enrolment_code`, `enrol_rejected:410`,
  `enrol_failed:429`, `no_base_url`). The supervisor reads a *missing* `sync.health` as a dead
  daemon; before, a Mac waiting for its code looked dead, and with a staged last-good pkg a
  re-enrolment could have rolled back a healthy agent.
- A pkg built before this change cannot answer `--version`; `install.sh` refuses it with a message
  saying to rebuild. That is deliberate — it is exactly the pkg that lied about its variant.
- A dev build now reports `0.1.0-dev` to the supervisor too. `isNewer` splits on `.`, so it still
  compares equal to `0.1.0`: a production pkg of the same base will not auto-replace a safe build.
  That was already true of the pkg versions; removing the safe build stays a manual step, as
  `smoke-test.md` says.
- Remote Login is a warning, not a refusal, for a pkg whose binary says it is the safe variant — the
  gate exists because a `shutdown` removes every recovery path, and that build cannot shut down.

## Notes

- Not decided here, and the most important thing the run found: **`pmset displaysleepnow` only locks if
  the logged-in user's screen-lock delay is `immediate`.** It was four hours on the test Mac, and it is
  the child's own setting — no admin needed to change it. The agent neither checks nor reports it, and
  `lock()` reports success regardless. This is the shape of [0009](./0009-deadfall-schedules-instants.md):
  a setting with the effect of an off switch. Choosing between checking it, reporting it as `DEGRADED`,
  or preferring `CGSession -suspend` needs a macOS measurement first (`verify-macos-claims`). Tracked
  in `docs/PUNCHLIST.md`.
- Also found and fixed without a decision: the rules page could never publish (a relative `fetch`
  resolved against the web origin); it would have published to a `pending` device that can never
  check in; the agent never writes to os_log, so every doc's `log stream` showed nothing; and the
  smoke test and the cutover's power-off step both used a `lock` window, which can never reach the
  shutdown rung.
- The first run's transcript of symptoms is in `docs/milestones/06-production-cutover.md`.
