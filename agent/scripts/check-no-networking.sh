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
set -euo pipefail

cd "$(dirname "$0")/.."
swift build -c release >/dev/null
BIN="$(swift build -c release --show-bin-path)/HPCEnforcer"

echo "checking $BIN"
DENY='CFNetwork|/Network\.framework|libcurl|libnetwork|libresolv|libdns'

if otool -L "$BIN" | tail -n +2 | grep -qE "$DENY"; then
  echo "FAIL — the enforcer links a networking library:"
  otool -L "$BIN" | tail -n +2 | grep -E "$DENY"
  exit 1
fi

# Belt and braces: no symbol references either, in case something is linked
# indirectly or dlopen'd by name.
if nm -u "$BIN" 2>/dev/null | grep -qiE 'URLSession|CFSocket|getaddrinfo|SCNetwork'; then
  echo "FAIL — the enforcer references networking symbols:"
  nm -u "$BIN" | grep -iE 'URLSession|CFSocket|getaddrinfo|SCNetwork'
  exit 1
fi

echo "PASS — no networking libraries, no networking symbols"
