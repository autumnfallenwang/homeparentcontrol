#!/bin/bash
# /tmp is wiped at boot on this machine, so the SIGTERM-at-shutdown evidence
# would not survive. Move both probes' logs to a persistent root-owned path.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p /usr/local/var/hpc-verify
chown root:wheel /usr/local/var/hpc-verify
chmod 755 /usr/local/var/hpc-verify

echo "== rebuilding swift probe with persistent log path =="
swiftc -O "$HERE/probe.swift" -o /usr/local/libexec/hpc-verify/probe
codesign -s - --force /usr/local/libexec/hpc-verify/probe
chown root:wheel /usr/local/libexec/hpc-verify/probe

echo "== patching bash probe =="
sed -i '' 's#/tmp/hpc-verify#/usr/local/var/hpc-verify#g' /usr/local/libexec/hpc-verify/probe.sh

echo "== reloading both daemons =="
for L in com.hpc.verify com.hpc.verifybash; do
  launchctl bootout "system/$L" 2>/dev/null || true
  launchctl bootstrap system "/Library/LaunchDaemons/$L.plist" 2>/dev/null || true
done
sleep 2
for L in com.hpc.verify com.hpc.verifybash; do
  printf "%-22s " "$L"; launchctl print "system/$L" 2>/dev/null | grep -E "^\s+state = " || echo "NOT LOADED"
done
echo; echo "logs now at /usr/local/var/hpc-verify/ :"; ls -la /usr/local/var/hpc-verify/
echo; echo "=== SAFE TO REBOOT NOW, then: sudo $HERE/check.sh ==="
