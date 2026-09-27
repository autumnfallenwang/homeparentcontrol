#!/usr/bin/env bash
# Build the installer package the supervisor installs and rolls back from.
#
# ⚠️ Until this existed there was nothing for §6.4's rollback to roll back TO.
# The supervisor's whole recovery path is "reinstall the cached last-good
# pkg, offline" and the pkg cache was empty by construction.
#
# ⚠️ **D.7 — there is no Developer ID Installer certificate**, so this package
# is UNSIGNED, and `installer -pkg` run as root bypasses Gatekeeper anyway:
# 📄 "When you install software using the `installer` command from the
# Terminal or a script, it will bypass quarantine and the Gatekeeper check."
# **The pinned SHA-256 is therefore the whole gate.** It is printed here,
# verified by the sync daemon before staging, and verified AGAIN by the
# supervisor before `installer` runs. "A digest nobody checks is worse than no
# digest, because it looks like a control."
#
#   ./agent/scripts/build-pkg.sh 0.2.0
#   ./agent/scripts/build-pkg.sh 0.2.0 --dev     # see below
#
# ⚠️ **`--dev` builds the SAFE variant** (`-DDEV_ENFORCEMENT`), where the real
# power-off is replaced by a log line. It exists so a smoke test can exercise
# the REAL install path — pkg, installer(8), launchd, enrolment, the lock —
# without the first run being the one that powers a machine off.
#
# Three things make a dev pkg impossible to mistake for a production one, and
# all three are deliberate: the VERSION carries a `-dev` suffix (in
# `pkgutil --pkg-info`, and — because `AgentVersion.current` derives it from
# the same `DEV_ENFORCEMENT` flag — in every binary's `--version`, in the
# `agent_version` every sync reports, and as Agent on the parent's device page), the
# filename carries it, and `install.sh` refuses it without `--allow-dev`. A
# safe binary installed by accident is an agent that logs "would shut down"
# for ever and looks completely healthy.
#
# ⚠️ Until the first real smoke test, "every binary" was false: the suffix
# reached only the pkg, and the installed safe build reported plain `0.1.0`.
# So this script now PROVES it — see the check after the build.
set -euo pipefail

VERSION="${1:?usage: build-pkg.sh <version> [--dev]}"

# ── The pkg version must be the version the binaries report.
#
# ⚠️ If they differ, the supervisor's `isNewer(desired, running)` compares the
# pkg's version against the binary's self-report, finds the pkg newer every
# tick, and reinstalls it for ever. One source of truth, checked here.
SRC_VERSION="$(sed -n 's/.*static let base = "\(.*\)"/\1/p' \
  "$(dirname "$0")/../Sources/HPCAgentIO/AgentVersion.swift" | head -1)"
if [ "$VERSION" != "$SRC_VERSION" ]; then
  echo "ERROR: asked for $VERSION but AgentVersion.base is '$SRC_VERSION'." >&2
  echo "  Bump agent/Sources/HPCAgentIO/AgentVersion.swift, not just this argument." >&2
  exit 1
fi
DEV_FLAGS=""
SUFFIX=""
if [ "${2:-}" = "--dev" ]; then
  DEV_FLAGS="-Xswiftc -DDEV_ENFORCEMENT"
  SUFFIX="-DEV"
  # ⚠️ The suffix goes into the VERSION, not just the filename. A filename is
  # forgotten the moment the pkg is copied; a version travels with the agent
  # to the control plane and onto the device card.
  VERSION="${VERSION}-dev"
  echo "⚠️  BUILDING THE SAFE VARIANT — shutdown is replaced by a log line."
  echo "   Version will be $VERSION. Do NOT ship this."
fi
cd "$(dirname "$0")/../.."
ROOT="$PWD"
OUT="$ROOT/agent/.build/pkg"
STAGE="$OUT/root"

# ⚠️ Release. Without `--dev` this contains the REAL shutdown; getting that
# backwards produces an agent that logs "would shut down" for ever and looks
# perfectly healthy while doing it.
echo "── building release binaries${SUFFIX:+ (SAFE VARIANT)}"
# shellcheck disable=SC2086  # DEV_FLAGS is two separate argv words or none.
swift build -c release --package-path agent $DEV_FLAGS >/dev/null
BIN="$(swift build -c release --package-path agent --show-bin-path)"

# ── ★ Ask every binary what it is, before any of them is packaged.
#
# This is the check that would have caught the smoke test's `0.1.0` safe
# build. It also catches a STALE binary: release and dev builds share one
# `.build` directory, so an incremental build that did not recompile under
# the new flag would ship the wrong variant with the right filename.
for exe in HPCEnforcer HPCSync HPCDeadfall HPCSupervisor; do
  REPORTED="$("$BIN/$exe" --version 2>/dev/null || true)"
  if [ "$REPORTED" != "$VERSION" ]; then
    echo "ERROR: $exe reports '${REPORTED:-nothing}', but this pkg is $VERSION." >&2
    echo "  The binaries do not match the variant being packaged. Refusing." >&2
    exit 1
  fi
done
echo "   ✔ all four binaries report $VERSION"

rm -rf "$STAGE"
mkdir -p "$STAGE/usr/local/libexec" "$STAGE/Library/LaunchDaemons"

install -m 755 "$BIN/HPCEnforcer"   "$STAGE/usr/local/libexec/hpc-enforcerd"
install -m 755 "$BIN/HPCSync"       "$STAGE/usr/local/libexec/hpc-sync"
install -m 755 "$BIN/HPCDeadfall"   "$STAGE/usr/local/libexec/hpc-deadfall"
# ⚠️ A.24 — the supervisor is in the payload but NEVER self-applies. The
# postinstall below loads it only when launchd has never heard of it (a first
# install) and never boots it out or restarts it: it is "the one component
# that cannot be rolled back in place", so a supervisor bump is an attended
# install, a couple of times a year.
install -m 755 "$BIN/HPCSupervisor" "$STAGE/usr/local/libexec/hpc-supervisor"

for job in enforcerd sync supervisor; do
  install -m 644 "$ROOT/agent/scripts/com.hpc.$job.plist" \
    "$STAGE/Library/LaunchDaemons/com.hpc.$job.plist"
done
# ⚠️ com.hpc.deadfall.plist is absent on purpose. Sync generates it from the
# active policy (§4.6) — a packaged one would carry a bedtime that never
# follows the schedule it exists to back up.

mkdir -p "$OUT/scripts"
cat > "$OUT/scripts/postinstall" <<'POST'
#!/bin/bash
# Bootstrap the jobs the payload just replaced. Idempotent: `bootout` of an
# unloaded job is a harmless error, hence the `|| true`.
set -u
mkdir -p /var/db/homeparentcontrol/spool /var/db/homeparentcontrol/pkgs
mkdir -p /var/log/homeparentcontrol
chown -R root:wheel /var/db/homeparentcontrol
chmod 700 /var/db/homeparentcontrol

# ⚠️ WAIT between bootout and bootstrap. `bootout` returns before the old
# process has exited, and bootstrapping into that window fails with
# "Bootstrap failed: 5: Input/output error". This used to be two lines with
# `|| true` on each: on a FIRST install nothing was loaded, so it worked; on
# every REINSTALL — including every supervisor-driven upgrade — it left the
# enforcer and sync unloaded, silently. An upgrade that stops enforcement.
# Found on the second on-hardware install, 2026-09-26.
reload() {
  job="$1"
  launchctl bootout "system/com.hpc.$job" 2>/dev/null || true
  i=0
  while launchctl print "system/com.hpc.$job" >/dev/null 2>&1 && [ "$i" -lt 30 ]; do
    sleep 1; i=$((i + 1))
  done
  i=0
  until launchctl bootstrap system "/Library/LaunchDaemons/com.hpc.$job.plist" 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -ge 15 ]; then
      echo "postinstall: could not load com.hpc.$job" >&2
      return 1
    fi
    sleep 1
  done
}
# Loud, not `|| true`: an installer that reports success while the enforcer
# is not loaded is the one outcome worse than a failed install.
FAILED=0
for job in enforcerd sync; do reload "$job" || FAILED=1; done
# ⚠️ com.hpc.supervisor is NOT restarted here. A.24: the updater does not
# update itself, and restarting it mid-install is how it would.
#
# ★ But it must be LOADED once, and on a first install nothing else ever
# loads it. `install.sh` checks all three jobs, so every first install failed
# — found on the first real smoke test. `print` succeeds iff launchd already
# knows the job, which is exactly the supervisor-driven upgrade (it is the
# process running this script), so there it is a no-op: never a bootout,
# never a restart. ADR 0010.
launchctl print system/com.hpc.supervisor >/dev/null 2>&1 \
  || launchctl bootstrap system /Library/LaunchDaemons/com.hpc.supervisor.plist || true
exit "$FAILED"
POST
chmod 755 "$OUT/scripts/postinstall"

PKG="$OUT/homeparentcontrol-$VERSION.pkg"
echo "── building $PKG"
pkgbuild \
  --root "$STAGE" \
  --scripts "$OUT/scripts" \
  --identifier com.hpc.agent \
  --version "$VERSION" \
  --install-location / \
  "$PKG" >/dev/null

DIGEST="$(shasum -a 256 "$PKG" | awk '{print $1}')"
printf '%s' "$DIGEST" > "$PKG.sha256"

cat <<SUMMARY

built   $PKG
sha256  $DIGEST${SUFFIX:+
        ⚠️  SAFE VARIANT — shutdown is a log line. install.sh needs --allow-dev.}

Publish that digest as AGENT_PKG_SHA256 alongside AGENT_PKG_URL. The sync
daemon refuses to stage a package whose bytes do not match, and the
supervisor refuses to install one — deliberately, twice.

To stage it by hand for a rollback test:
  sudo mkdir -p /var/db/homeparentcontrol/pkgs
  sudo cp "$PKG"        /var/db/homeparentcontrol/pkgs/$VERSION.pkg
  sudo cp "$PKG.sha256" /var/db/homeparentcontrol/pkgs/$VERSION.pkg.sha256
SUMMARY
