#!/bin/bash
# clock-tamper/agent-e2e.sh — the real agent 0.2.0 against a moved clock (ADR 0015).
#
#   sudo tools/verify/clock-tamper/agent-e2e.sh <pkg> <log-dir>
#
# ⚠️ ONLY on a Mac whose policy has NO bedtime window — Aaron's Macbook,
# policy v11. The clock is moved for real while the agent is installed.
#
# Installs the pkg, then three rounds, each like a child would:
#   A  automatic time OFF, clock back 30 min   → the agent should turn it back on
#   B  automatic time ON,  clock back 10 min   → the agent should set it from the server
#   C  a child who keeps doing it: re-apply −30 min whenever the agent fixes it,
#      until the ENFORCER is seen to have measured it (time.state.json), ≤ 3 min
# Always ends with network time on and the clock set from time.apple.com.
set -u

PKG=${1:?usage: sudo $0 <pkg> <log-dir>}
OUT=${2:?usage: sudo $0 <pkg> <log-dir>}
[ "$(id -u)" = 0 ] || { echo "needs root: sudo $0 …" >&2; exit 1; }
mkdir -p "$OUT"
LOG="$OUT/agent-e2e.log"
: > "$LOG"
ROOT=/var/db/homeparentcontrol

say() { echo "[$(date -u '+%H:%M:%SZ')] $*" | tee -a "$LOG"; }
# sntp: time.apple.com minus this Mac, seconds. Query only.
offset() { sntp time.apple.com 2>/dev/null | awk '/time.apple.com/ {print $1; exit}'; }
abs_lt() { awk -v o="$1" -v l="$2" 'BEGIN { if (o < 0) o = -o; exit !(o < l) }'; }
step_by() { date -f %s "$(( $(date +%s) + $1 ))" > /dev/null; }
ntp() { systemsetup -getusingnetworktime 2>&1 | awk -F': ' '{print $2}'; }
state() { python3 -c "import json;d=json.load(open('$ROOT/time.state.json'));print('offset=%.0fs reported=%.0fs' % (d.get('offset_s',0), d.get('reported_offset_s',0)))" 2>/dev/null; }

restore() {
    systemsetup -setusingnetworktime on > /dev/null 2>&1
    sntp -sS time.apple.com > /dev/null 2>&1
    say "RESTORED: network time $(ntp); offset vs Apple $(offset)s"
    echo "════ log: $LOG ════"
}
trap restore EXIT
trap 'exit 130' INT TERM

# ── Install. A manual install enforces at once — no shadow soak (§6.5).
say "installing $(basename "$PKG")"
xattr -p com.apple.quarantine "$PKG" >/dev/null 2>&1 && { say "ERROR: pkg is quarantined"; exit 1; }
installer -pkg "$PKG" -target / >> "$LOG" 2>&1 || { say "ERROR: installer failed"; exit 1; }
for exe in hpc-enforcerd hpc-sync hpc-supervisor hpc-deadfall; do
    say "   $exe $(/usr/local/libexec/$exe --version)"
done

say "waiting for the first trusted-time files (≤ 3 min)"
for _ in $(seq 1 90); do
    [ -f $ROOT/time.server.json ] && [ -f $ROOT/time.state.json ] && break
    sleep 2
done
[ -f $ROOT/time.server.json ] || { say "ERROR: no time.server.json — sync has not synced"; exit 1; }
[ -f $ROOT/time.state.json ] || { say "ERROR: no time.state.json — the enforcer has not ticked"; exit 1; }
say "   time.server.json: $(cat $ROOT/time.server.json)"
say "   time.state.json:  $(state)"
say "   network time: $(ntp)"

# Wait until the clock is fixed or the deadline passes. Prints how long it took.
wait_fixed() {
    local limit=$1 waited=0 o
    while [ $waited -lt "$limit" ]; do
        sleep 3; waited=$((waited + 3))
        o=$(offset)
        if [ -n "$o" ] && abs_lt "$o" 5; then
            say "   ✔ clock right again after ~${waited}s (offset ${o}s); network time $(ntp); enforcer $(state)"
            return 0
        fi
    done
    say "   ✘ NOT fixed after ${limit}s (offset ${o}s); network time $(ntp); enforcer $(state)"
    return 1
}

# ── A
say "A  automatic time OFF, clock back 30 min"
systemsetup -setusingnetworktime off > /dev/null 2>&1
step_by -1800
say "   offset now $(offset)s, network time $(ntp)"
wait_fixed 150

# ── B
say "B  automatic time ON, clock back 10 min"
systemsetup -setusingnetworktime on > /dev/null 2>&1
sleep 5
step_by -600
say "   offset now $(offset)s, network time $(ntp)"
wait_fixed 150

# ── C
say "C  persistent: keep the clock 30 min back until the enforcer has measured it"
systemsetup -setusingnetworktime off > /dev/null 2>&1
step_by -1800
SEEN=""
for _ in $(seq 1 60); do
    sleep 3
    if python3 -c "import json,sys;d=json.load(open('$ROOT/time.state.json'));sys.exit(0 if abs(d.get('reported_offset_s',0)+1800)<120 else 1)" 2>/dev/null; then
        SEEN=yes; break
    fi
    o=$(offset)
    if [ -n "$o" ] && abs_lt "$o" 60; then
        say "   agent fixed it ($(ntp)); moving it back again"
        systemsetup -setusingnetworktime off > /dev/null 2>&1
        step_by -1800
    fi
done
if [ -n "$SEEN" ]; then
    say "   ✔ the enforcer measured the step: $(state)"
else
    say "   ✘ the enforcer never recorded −1800 s within 3 min: $(state)"
fi
systemsetup -setusingnetworktime on > /dev/null 2>&1
wait_fixed 120
say "   enforcer after: $(state)"
say "   deadfall plist entries: $(grep -c '<key>Hour</key>' /Library/LaunchDaemons/com.hpc.deadfall.plist 2>/dev/null || echo 0)"
say "done"
