#!/bin/bash
# Adds a SECOND test daemon whose entry point is a BASH SCRIPT — i.e. exactly
# POC 1's design — so the reboot compares script-vs-Mach-O under BTM.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
mkdir -p /tmp/hpc-verify && chmod 777 /tmp/hpc-verify
mkdir -p /usr/local/libexec/hpc-verify

cat > /usr/local/libexec/hpc-verify/probe.sh <<'BASH'
#!/bin/bash
echo "$(date -u +%FT%TZ) BASH_START euid=$EUID" >> /tmp/hpc-verify/probe-bash.log
trap 'echo "$(date -u +%FT%TZ) BASH_SIGTERM_RECEIVED" >> /tmp/hpc-verify/probe-bash.log; exit 0' TERM
while true; do sleep 30; echo "$(date -u +%FT%TZ) bash_tick" >> /tmp/hpc-verify/probe-bash.log; done
BASH
chmod 755 /usr/local/libexec/hpc-verify/probe.sh
chown root:wheel /usr/local/libexec/hpc-verify/probe.sh

cat > /Library/LaunchDaemons/com.hpc.verifybash.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.hpc.verifybash</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string>
    <string>/usr/local/libexec/hpc-verify/probe.sh</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/hpc-verify/bash-stdout.log</string>
  <key>StandardErrorPath</key><string>/tmp/hpc-verify/bash-stderr.log</string>
</dict></plist>
PLIST
chown root:wheel /Library/LaunchDaemons/com.hpc.verifybash.plist
chmod 644 /Library/LaunchDaemons/com.hpc.verifybash.plist
launchctl bootstrap system /Library/LaunchDaemons/com.hpc.verifybash.plist 2>/dev/null || true
sleep 2
echo "== bash daemon state =="
launchctl print system/com.hpc.verifybash 2>&1 | sed -n '1,8p'
echo; echo "== BTM: BASH-entry daemon, BEFORE reboot =="
sfltool dumpbtm 2>/dev/null | grep -B2 -A10 "verifybash" || echo "   (no entry found)"
echo; echo "=== NOW REBOOT, then run: sudo $(cd "$(dirname "$0")" && pwd)/check.sh ==="
