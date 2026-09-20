#!/usr/bin/env bash
# §9 exit criterion: `otool -L` shows no networking symbols in the enforcer.
#
# This is not hygiene — it is the PROOF behind V1–V9. The contract's central
# unproven claim is that enforcement is independent of the network, and a
# binary that cannot open a socket cannot be talked out of enforcing by a
# server, a DNS failure or a cable.
#
# ⚠️ Scope, measured rather than assumed: a DEAD `import Network` passes this
# check, because Swift does not link a framework whose symbols are never used.
# Real usage — one `NWPathMonitor()` — fails it, verified by adding exactly
# that and watching it go red. So this proves "no network CAPABILITY", not "no
# import", which is the property that actually matters.
#
# ⚠️ Milestone 03 widened this from one binary to three, and added the half
# that makes it a real check: `HPCSync` is asserted to FAIL the same test. A
# detector that has silently stopped detecting would otherwise masquerade as
# three passes, and three vacuous passes read exactly like three real ones.
set -euo pipefail

cd "$(dirname "$0")/.."
swift build -c release >/dev/null
BIN_DIR="$(swift build -c release --show-bin-path)"

DENY='CFNetwork|/Network\.framework|libcurl|libnetwork|libresolv|libdns'
SYMBOLS='URLSession|CFSocket|getaddrinfo|SCNetwork|nw_connection'

# Every binary that must be unable to reach the network.
#
#   HPCEnforcer   — the claim itself.
#   HPCDeadfall   — exists precisely for the case where everything else is
#                   dead, which very much includes the network.
#   HPCSupervisor — §6.4's rollback path is explicitly "OFFLINE, no network";
#                   the case it exists for is the one where the new version
#                   broke the sync daemon.
OFFLINE=(HPCEnforcer HPCDeadfall HPCSupervisor)

fails=0

for name in "${OFFLINE[@]}"; do
  bin="$BIN_DIR/$name"
  echo "checking $name — must be OFFLINE"

  if otool -L "$bin" | tail -n +2 | grep -qE "$DENY"; then
    echo "  FAIL — links a networking library:"
    otool -L "$bin" | tail -n +2 | grep -E "$DENY" | sed 's/^/    /'
    fails=1
    continue
  fi

  # Belt and braces: no symbol references either, in case something is linked
  # indirectly or dlopen'd by name.
  if nm -u "$bin" 2>/dev/null | grep -qiE "$SYMBOLS"; then
    echo "  FAIL — references networking symbols:"
    nm -u "$bin" | grep -iE "$SYMBOLS" | sed 's/^/    /'
    fails=1
    continue
  fi

  echo "  PASS — no networking libraries, no networking symbols"
done

# ── The control. A.4: "the sync daemon is the only component that talks to the
# control plane API", so HPCSync MUST trip the detector that the others must
# not. If this ever passes, the detector has stopped working and every PASS
# above is worthless.
echo "checking HPCSync — must be ONLINE (this is the control)"
if otool -L "$BIN_DIR/HPCSync" | tail -n +2 | grep -qE "$DENY" \
  || nm -u "$BIN_DIR/HPCSync" 2>/dev/null | grep -qiE "$SYMBOLS"; then
  echo "  PASS — the sync daemon does link networking, so the check discriminates"
else
  echo "  FAIL — HPCSync shows NO networking symbols."
  echo "         Either the sync daemon lost its client, or this check has"
  echo "         stopped detecting anything. Every PASS above is void until"
  echo "         you know which."
  fails=1
fi

exit "$fails"
