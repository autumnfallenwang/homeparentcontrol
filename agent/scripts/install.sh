#!/usr/bin/env bash
# Install the agent on the child's Mac, the real way, and refuse to finish if
# anything about the install would make it fail silently.
#
#   sudo agent/scripts/install.sh [pkg] --base-url <url> [--code HPC-…] [--allow-dev]
#
#   sudo agent/scripts/install.sh \
#     --base-url http://homeparentcontrol-api.arch.internal/api/agent/v1/ \
#     --code HPC-XXXX-XXXX-XXXX
#
# `--base-url` is written to /var/db/homeparentcontrol/base_url — the one place
# a pkg upgrade cannot overwrite — and `--code` stages the enrolment code. Sync
# looks for both every tick, so there is nothing to restart afterwards.
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
PKG=""
ALLOW_DEV=0
BASE_URL=""
CODE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --allow-dev) ALLOW_DEV=1 ;;
    --base-url) BASE_URL="${2:?--base-url needs a URL}"; shift ;;
    --code) CODE="${2:?--code needs an enrolment code}"; shift ;;
    -*) echo "ERROR: unknown option $1" >&2; exit 1 ;;
    *) PKG="$1" ;;
  esac
  shift
done

# Checked before anything is built or installed, so a typo costs nothing.
case "$BASE_URL" in
  "" | http://* | https://*) ;;
  *) echo "ERROR: --base-url must start with http:// or https:// (got '$BASE_URL')" >&2; exit 1 ;;
esac
case "$CODE" in
  "" | HPC-*) ;;
  *) echo "ERROR: --code looks wrong (got '$CODE'); codes start with HPC-" >&2; exit 1 ;;
esac

# ── 1. Build, unless a pkg was handed to us.
if [ -z "$PKG" ]; then
  VERSION="$(sed -n 's/.*static let base = "\(.*\)"/\1/p' \
    agent/Sources/HPCAgentIO/AgentVersion.swift | head -1)"
  [ -n "$VERSION" ] || { echo "ERROR: could not read the agent version" >&2; exit 1; }
  echo "── building $VERSION"
  # ⚠️ NOT -DDEV_ENFORCEMENT. The V-series builds the safe variant; a real
  # install must contain the real shutdown. Getting this backwards produces
  # an agent that logs "would shut down" for ever and looks fine.
  bash agent/scripts/build-pkg.sh "$VERSION" >/dev/null
  PKG="$ROOT/agent/.build/pkg/homeparentcontrol-$VERSION.pkg"
fi

[ -f "$PKG" ] || { echo "ERROR: $PKG not found" >&2; exit 1; }

# ── 2. ⚠️ Quarantine, BEFORE anything in the pkg is run or installed.
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

# ── 3. ⚠️ Is this the safe variant? Ask the BINARY, not the filename.
#
# Found on the first real smoke test: the filename said `-dev` and the binary
# inside reported plain `0.1.0`, because the suffix never reached it. Since
# `AgentVersion` derives `-dev` from the same flag that removes the power-off,
# the packaged enforcer's own `--version` is now the one honest answer — and a
# pkg whose name disagrees with it is refused outright, in either direction.
# (After the quarantine check on purpose: a quarantined unsigned binary is
# killed the moment it runs.)
INSPECT="$(mktemp -d)"
trap 'rm -rf "$INSPECT"' EXIT
pkgutil --expand-full "$PKG" "$INSPECT/pkg" >/dev/null
REPORTED="$("$INSPECT/pkg/Payload/usr/local/libexec/hpc-enforcerd" --version 2>/dev/null || true)"
if [ -z "$REPORTED" ]; then
  echo "ERROR: the packaged hpc-enforcerd did not answer --version." >&2
  echo "  A pkg built before the version fix cannot say which variant it is." >&2
  echo "  Rebuild it: agent/scripts/build-pkg.sh <version> [--dev]" >&2
  exit 1
fi
case "$REPORTED" in *-dev) SAFE=1 ;; *) SAFE=0 ;; esac
case "$PKG" in *-dev.pkg | *-DEV.pkg) NAMED_SAFE=1 ;; *) NAMED_SAFE=0 ;; esac
if [ "$SAFE" -ne "$NAMED_SAFE" ]; then
  echo "ERROR: $(basename "$PKG") is mislabelled — its enforcer reports $REPORTED." >&2
  echo "  One of the two is lying about whether this build can power the Mac off." >&2
  exit 1
fi
if [ "$SAFE" -eq 1 ]; then
  if [ "$ALLOW_DEV" -ne 1 ]; then
    echo "ERROR: $(basename "$PKG") is the SAFE VARIANT ($REPORTED) — shutdown is a log line." >&2
    echo "  Right for a first smoke test, wrong for everything after." >&2
    echo "  Re-run with --allow-dev if that is what you want." >&2
    exit 1
  fi
  echo "⚠️  Installing the SAFE VARIANT ($REPORTED). This agent will NOT power the Mac off."
  echo "   It reports that version everywhere, including on the device card."
fi

# ── 4. Remote Login — the recovery path.
#
# ⚠️ Under `shutdown` there is NO remote recovery path: you cannot SSH into a
# machine that is off. Remote Login is what makes the grace period a real
# 300-second budget rather than a countdown to a trip upstairs. The schema
# deliberately cannot express disabling it (A.34); this checks the machine
# agrees.
#
# For the SAFE variant it is a warning, not a refusal: that build provably
# cannot power off (step 3 just asked it), so the reason for the gate does not
# apply. It is still worth having — SSH is how you get back in while the
# screen is locked — which is why it is said out loud.
#
# ⚠️ Enable it in System Settings, not with `systemsetup -setremotelogin on`:
# that needs Full Disk Access for the terminal even under sudo, and fails with
# a message about privileges that reads like a sudo problem.
REMOTE="$(systemsetup -getremotelogin 2>&1 || true)"
if ! printf '%s' "$REMOTE" | grep -qi "remote login: on"; then
  if [ "$SAFE" -eq 1 ]; then
    echo "⚠️  Remote Login is not on (${REMOTE:-no answer}). Allowed for the safe variant;"
    echo "   you will want it to get back in while the screen is locked."
  else
    echo "ERROR: Remote Login is not on (${REMOTE:-no answer})." >&2
    echo "  Under 'shutdown' there is no remote recovery path at all — you cannot" >&2
    echo "  SSH into a machine that is powered off. Enable it first:" >&2
    echo "    System Settings → General → Sharing → Remote Login" >&2
    exit 1
  fi
fi

echo "── installing $(basename "$PKG")"
/usr/sbin/installer -pkg "$PKG" -target / >/dev/null

# ── 5. Verify the installed tree is clean too.
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

# ── 6. Did launchd actually accept the jobs?
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

# ── 7. Background Task Management disposition.
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

# ── 8. Where to reach the control plane, and the code to enrol with.
#
# ⚠️ A FILE, not the plist and not `launchctl setenv`. setenv is refused under
# SIP; a URL edited into the plist is silently reset by the next pkg upgrade,
# which reinstalls the plist. Both were found on the first real smoke test.
# Sync re-reads both files every tick, so neither needs a restart.
STATE=/var/db/homeparentcontrol
if [ -n "$BASE_URL" ]; then
  printf '%s\n' "$BASE_URL" > "$STATE/base_url"
  chmod 644 "$STATE/base_url"
  echo "   ✔ base URL: $BASE_URL"
elif [ -s "$STATE/base_url" ]; then
  echo "   ✔ base URL (kept): $(cat "$STATE/base_url")"
else
  echo "⚠️  No base URL. This agent cannot enrol or sync until you re-run with"
  echo "   --base-url, e.g. http://homeparentcontrol-api.arch.internal/api/agent/v1/"
fi
if [ -n "$CODE" ]; then
  printf '%s' "$CODE" > "$STATE/enrolment_code"
  chmod 600 "$STATE/enrolment_code"
  rm -f "$STATE/enrolment_code.rejected"
  echo "   ✔ enrolment code staged — sync exchanges it within a minute"
fi

cat <<'NEXT'

── installed.

Next, in order:

  1. Enrol it, if you did not pass --code. Create the Mac in the parent UI
     (/setup) and stage the code IMMEDIATELY — it is single-use and expires
     in 60 minutes. Sync picks it up within a minute; nothing to restart:
       printf 'HPC-XXXX-XXXX-XXXX' | sudo tee /var/db/homeparentcontrol/enrolment_code
     (Do NOT re-run this script for that: with no pkg argument it builds and
     installs the PRODUCTION variant.) Then check:
       sudo cat /var/db/homeparentcontrol/sync.health
     `enrol_rejected:410` means the code expired — make a new one. A rejected
     code is moved to enrolment_code.rejected and never retried.

  2. Watch it decide (NOT `log stream` — the agent does not write to os_log):
       sudo agent/scripts/watch.sh

  3. ⚠️ BEFORE the first real bedtime, have the abort ready in another shell:
       sudo killall shutdown
     That is what made POC 1's power-off testing safe. A scheduled
     `shutdown -h +N` is cancellable right up until it fires.

  4. Reboot and re-run this script's checks — surviving a reboot is its own
     exit criterion, and BTM disposition is only meaningful after one.
NEXT
