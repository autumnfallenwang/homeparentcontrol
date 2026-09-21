#!/usr/bin/env bash
# Install the agent on the child's Mac, the real way, and refuse to finish if
# anything about the install would make it fail silently.
#
#   sudo agent/scripts/install.sh [path/to/homeparentcontrol-<version>.pkg]
#   sudo agent/scripts/install.sh <pkg> --allow-dev     # a SAFE-variant pkg
#
# With no argument it builds one from the working tree (release, WITHOUT
# -DDEV_ENFORCEMENT) and installs that.
#
# ⚠️ A pkg built with `build-pkg.sh <v> --dev` has the real power-off
# replaced by a log line. It is right for a first smoke test and wrong for
# everything after, so installing one takes `--allow-dev`. An agent that
# logs "would shut down" for ever looks completely healthy.
#
# ⚠️ **Every check in here exists because its failure mode is SILENT.** A
# quarantined binary is SIGKILLed with no dialog; a plist that launchd
# refuses leaves no trace in the UI; a missing Remote Login leaves no way
# back in after a `shutdown`. None of them look like a problem until 21:30.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run with sudo — launchd refuses a daemon that is not root-owned." >&2
  exit 1
fi

cd "$(dirname "$0")/../.."
ROOT="$PWD"
PKG="${1:-}"
ALLOW_DEV=0
for arg in "$@"; do [ "$arg" = "--allow-dev" ] && ALLOW_DEV=1; done
[ "${PKG:-}" = "--allow-dev" ] && PKG=""

# ── 0. Refuse to install onto a Mac that cannot be recovered.
#
# ⚠️ Under `shutdown` there is NO remote recovery path: you cannot SSH into a
# machine that is off. Remote Login is what makes the grace period a real
# 300-second budget rather than a countdown to a trip upstairs. The schema
# deliberately cannot express disabling it (A.34); this checks the machine
# agrees.
if ! systemsetup -getremotelogin 2>/dev/null | grep -qi "on"; then
  echo "ERROR: Remote Login is OFF." >&2
  echo "  Under 'shutdown' there is no remote recovery path at all — you cannot" >&2
  echo "  SSH into a machine that is powered off. Enable it first:" >&2
  echo "    sudo systemsetup -setremotelogin on" >&2
  exit 1
fi

# ── 1. Build, unless a pkg was handed to us.
if [ -z "$PKG" ]; then
  VERSION="$(sed -n 's/.*static let version = "\(.*\)"/\1/p' \
    agent/Sources/HPCEnforcer/main.swift | head -1)"
  [ -n "$VERSION" ] || { echo "ERROR: could not read the agent version" >&2; exit 1; }
  echo "── building $VERSION"
  # ⚠️ NOT -DDEV_ENFORCEMENT. The V-series builds the safe variant; a real
  # install must contain the real shutdown. Getting this backwards produces
  # an agent that logs "would shut down" for ever and looks fine.
  bash agent/scripts/build-pkg.sh "$VERSION" >/dev/null
  PKG="$ROOT/agent/.build/pkg/homeparentcontrol-$VERSION.pkg"
fi

[ -f "$PKG" ] || { echo "ERROR: $PKG not found" >&2; exit 1; }

# ── ⚠️ Is this the safe variant, and did you mean it?
case "$PKG" in
  *-DEV.pkg|*-dev.pkg)
    if [ "$ALLOW_DEV" -ne 1 ]; then
      echo "ERROR: $(basename "$PKG") is the SAFE VARIANT — shutdown is a log line." >&2
      echo "  Right for a first smoke test, wrong for everything after." >&2
      echo "  Re-run with --allow-dev if that is what you want." >&2
      exit 1
    fi
    echo "⚠️  Installing the SAFE VARIANT. This agent will NOT power the Mac off."
    echo "   It reports its version with a -dev suffix, which shows on the device card."
    ;;
esac

# ── 2. ⚠️ Quarantine, BEFORE installing.
#
# 📄 A quarantined non-notarized Mach-O is SIGKILLed with no dialog and no
# log line anyone would look at, and macOS 27 will not load a quarantined
# `.plist` at all. Under D.7 there is no Developer ID certificate, so nothing
# clears the flag for us.
#
# It is set by the DOWNLOAD, not by the build: `curl`, Safari, `unzip` and
# `ditto -x -k` all propagate it; `tar` and `rsync` do not. Verified on this
# hardware. If this fires, re-ship the pkg with tar or rsync rather than
# stripping the flag — stripping it hides how it got there.
if xattr -p com.apple.quarantine "$PKG" >/dev/null 2>&1; then
  echo "ERROR: $PKG carries com.apple.quarantine." >&2
  echo "  A quarantined non-notarized binary is SIGKILLed silently." >&2
  echo "  Re-ship it with tar or rsync (NOT .zip / unzip / ditto -x -k)," >&2
  echo "  or clear it deliberately:  xattr -d com.apple.quarantine '$PKG'" >&2
  exit 1
fi

echo "── installing $(basename "$PKG")"
/usr/sbin/installer -pkg "$PKG" -target / >/dev/null

# ── 3. Verify the installed tree is clean too.
#
# The pkg being clean does not prove the payload is: `installer` preserves
# extended attributes from the archive.
DIRTY="$(xattr -r -l /usr/local/libexec/hpc-* /Library/LaunchDaemons/com.hpc.*.plist 2>/dev/null \
  | grep -c 'com.apple.quarantine' || true)"
if [ "$DIRTY" -ne 0 ]; then
  echo "ERROR: $DIRTY installed file(s) carry com.apple.quarantine." >&2
  xattr -r -l /usr/local/libexec/hpc-* /Library/LaunchDaemons/com.hpc.*.plist 2>/dev/null \
    | grep -B1 'com.apple.quarantine' >&2 || true
  exit 1
fi
echo "   ✔ no com.apple.quarantine anywhere in the install tree"

# ── 4. Did launchd actually accept the jobs?
#
# ⚠️ `bootstrap` exits 0 for a job it then refuses to run. The postinstall
# script already bootstrapped them; this asks launchd what it thinks, which
# is a different question.
sleep 2
MISSING=""
for job in enforcerd sync supervisor; do
  launchctl print "system/com.hpc.$job" >/dev/null 2>&1 || MISSING="$MISSING com.hpc.$job"
done
if [ -n "$MISSING" ]; then
  echo "ERROR: launchd does not know about:$MISSING" >&2
  echo "  Check /var/log/homeparentcontrol/ and 'launchctl print system/<label>'." >&2
  exit 1
fi
echo "   ✔ launchd has all three daemons"

# ── 5. Background Task Management disposition.
#
# ⚠️ Research claimed BTM leaves script and ad-hoc LaunchDaemons `disallowed`
# after a reboot — three tracks agreed, one citing Apple DTS. Direct testing
# refuted it: both returned [enabled, allowed] and ran. This prints the live
# answer rather than trusting either, because it is the claim that decided
# what language the agent is written in.
echo "── BTM disposition (expect: enabled, allowed)"
sfltool dumpbtm 2>/dev/null \
  | grep -A4 -i 'com\.hpc\.' \
  | grep -E 'Identifier|Disposition' \
  | sed 's/^/   /' || echo "   (sfltool returned nothing — check manually)"

cat <<'NEXT'

── installed.

Next, in order:

  1. Enrol it. Create the device in the parent UI (/setup), then:
       echo 'HPC-XXXX-XXXX-XXXX' | sudo tee /var/db/homeparentcontrol/enrolment_code
       sudo launchctl kickstart -k system/com.hpc.sync
     The code is single-use and expires in 60 minutes.

  2. Watch the first tick land:
       sudo log stream --predicate 'process == "hpc-enforcerd"' --info

  3. ⚠️ BEFORE the first real bedtime, have the abort ready in another shell:
       sudo killall shutdown
     That is what made POC 1's power-off testing safe. A scheduled
     `shutdown -h +N` is cancellable right up until it fires.

  4. Reboot and re-run this script's checks — surviving a reboot is its own
     exit criterion, and BTM disposition is only meaningful after one.
NEXT
