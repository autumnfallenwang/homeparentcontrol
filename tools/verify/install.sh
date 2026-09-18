#!/bin/bash
# Installs a TEMPORARY, ad-hoc-signed Mach-O LaunchDaemon to answer three
# open questions in one reboot. Fully reversed by uninstall.sh.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
CU=$(/usr/bin/stat -f "%Su" /dev/console); CUID=$(id -u "$CU")

mkdir -p /tmp/hpc-verify && chmod 777 /tmp/hpc-verify
: > /tmp/hpc-verify/probe.log && chmod 666 /tmp/hpc-verify/probe.log

echo "== building ad-hoc-signed Mach-O =="
mkdir -p /usr/local/libexec/hpc-verify
swiftc -O "$HERE/probe.swift" -o /usr/local/libexec/hpc-verify/probe
codesign -s - --force /usr/local/libexec/hpc-verify/probe
chown -R root:wheel /usr/local/libexec/hpc-verify
codesign -dv --verbose=4 /usr/local/libexec/hpc-verify/probe 2>&1 | sed -n '1,8p'
echo "quarantine xattrs (expect none):"; xattr -r /usr/local/libexec/hpc-verify || true

cat > /Library/LaunchDaemons/com.hpc.verify.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.hpc.verify</string>
  <key>ProgramArguments</key><array><string>/usr/local/libexec/hpc-verify/probe</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/hpc-verify/stdout.log</string>
  <key>StandardErrorPath</key><string>/tmp/hpc-verify/stderr.log</string>
</dict></plist>
PLIST
chown root:wheel /Library/LaunchDaemons/com.hpc.verify.plist
chmod 644 /Library/LaunchDaemons/com.hpc.verify.plist
launchctl bootstrap system /Library/LaunchDaemons/com.hpc.verify.plist 2>/dev/null || true
sleep 2
echo; echo "== daemon state =="; launchctl print system/com.hpc.verify 2>&1 | sed -n '1,12p'

echo; echo "== A0: root daemon -> GUI dialog with text field =="
echo "   console user: $CU ($CUID) — A DIALOG SHOULD APPEAR NOW"
launchctl asuser "$CUID" sudo -u "$CU" /usr/local/libexec/hpc-verify/probe --dialog || true

echo; echo "== BTM disposition (BEFORE reboot) =="
sfltool dumpbtm 2>/dev/null | grep -A12 -i "hpc.verify" || echo "   (no hpc.verify entry found)"

echo; echo "=== NOW REBOOT, then run: sudo $HERE/check.sh ==="
