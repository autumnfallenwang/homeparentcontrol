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
# all three are deliberate: the VERSION carries a `-dev` suffix (so it shows
# in `pkgutil --pkg-info` and in the `agent_version` every sync reports and
# the parent UI displays), the filename carries `-DEV`, and `install.sh`
# refuses it without `--allow-dev`. A safe binary installed by accident is an
# agent that logs "would shut down" for ever and looks completely healthy.
set -euo pipefail

VERSION="${1:?usage: build-pkg.sh <version> [--dev]}"
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

rm -rf "$STAGE"
mkdir -p "$STAGE/usr/local/libexec" "$STAGE/Library/LaunchDaemons"

install -m 755 "$BIN/HPCEnforcer"   "$STAGE/usr/local/libexec/hpc-enforcerd"
install -m 755 "$BIN/HPCSync"       "$STAGE/usr/local/libexec/hpc-sync"
install -m 755 "$BIN/HPCDeadfall"   "$STAGE/usr/local/libexec/hpc-deadfall"
# ⚠️ A.24 — the supervisor is in the payload but NEVER self-applies. The
# postinstall below deliberately does not kickstart com.hpc.supervisor: it is
# "the one component that cannot be rolled back in place", so a supervisor
# bump is an attended install, a couple of times a year.
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

for job in enforcerd sync; do
  launchctl bootout "system/com.hpc.$job" 2>/dev/null || true
  launchctl bootstrap system "/Library/LaunchDaemons/com.hpc.$job.plist" || true
done
# ⚠️ com.hpc.supervisor is NOT restarted here. A.24: the updater does not
# update itself, and restarting it mid-install is how it would.
exit 0
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
