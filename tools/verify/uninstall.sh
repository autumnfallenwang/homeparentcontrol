#!/bin/bash
set -uo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
launchctl bootout system/com.hpc.verify 2>/dev/null || true
launchctl bootout system/com.hpc.verifybash 2>/dev/null || true
rm -f /Library/LaunchDaemons/com.hpc.verify.plist /Library/LaunchDaemons/com.hpc.verifybash.plist
rm -rf /usr/local/libexec/hpc-verify
echo "removed both test daemons. (logs left at /usr/local/var/hpc-verify)"
rm -rf /usr/local/var/hpc-verify
