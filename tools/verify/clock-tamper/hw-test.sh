#!/bin/bash
# clock-tamper/hw-test.sh — move this Mac's clock the way a child would, watch
# what the probe sees, and try three ways to put it back.
#
#   sudo tools/verify/clock-tamper/hw-test.sh <probe-binary> <log-dir> [--no-sleep]
#
# ⚠️ Run it only on a Mac whose policy has NO bedtime window. The installed
# agent on this Mac ticks through every step below, and an agent with a window
# would act on the moved clock. (Aaron's Macbook, policy v11: no windows.)
#
# Always ends with network time ON and the clock set from time.apple.com,
# whatever happens — the trap runs on success, failure and Ctrl-C.
set -u

PROBE=${1:?usage: sudo $0 <probe-binary> <log-dir> [--no-sleep]}
OUT=${2:?usage: sudo $0 <probe-binary> <log-dir> [--no-sleep]}
SLEEP_TEST=1
[ "${3:-}" = "--no-sleep" ] && SLEEP_TEST=0
HEALTH=http://homeparentcontrol-api.arch.internal/api/agent/v1/health

[ "$(id -u)" = 0 ] || { echo "needs root: sudo $0 …" >&2; exit 1; }
RUN_AS=${SUDO_USER:-root}
mkdir -p "$OUT"
LOG="$OUT/hw-test.log"
PLOG="$OUT/probe.log"
: > "$LOG"

say() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }
# sntp's offset: time.apple.com minus this Mac, in seconds (+1800 = Mac 30 min slow). Query only.
offset() { sntp time.apple.com 2>/dev/null | awk '/time.apple.com/ {print $1; exit}'; }
step_by() { date -f %s "$(( $(date +%s) + $1 ))" > /dev/null; }

ORIG_NTP=$(systemsetup -getusingnetworktime 2>&1 | awk -F': ' '{print $2}')
ORIG_TZ=$(systemsetup -gettimezone 2>&1 | awk -F': ' '{print $2}')

restore() {
    say "RESTORE: time zone $ORIG_TZ, network time On, clock from time.apple.com"
    systemsetup -settimezone "$ORIG_TZ" > /dev/null 2>&1
    systemsetup -setusingnetworktime on > /dev/null 2>&1
    sntp -sS time.apple.com > /dev/null 2>&1
    say "final offset vs time.apple.com: $(offset)s"
    [ -n "${PROBE_PID:-}" ] && kill "$PROBE_PID" 2>/dev/null
    echo
    echo "════ what the probe saw ════"
    grep -E "STEP|SLEEP|ZONE|BOOTTIME|SESSION|CLOCK WRONG" "$PLOG"
    echo "════ logs: $LOG  $PLOG ════"
}
trap restore EXIT
trap 'exit 130' INT TERM

say "Q0 network time at start: '$ORIG_NTP' (read as root via systemsetup); zone $ORIG_TZ"
say "   offset vs time.apple.com: $(offset)s"

sudo -u "$RUN_AS" "$PROBE" 1800 "$HEALTH" > "$PLOG" 2>&1 &
PROBE_PID=$!
sleep 4

# Like Ivy: automatic time off first, or timed may undo the step on its own.
systemsetup -setusingnetworktime off > /dev/null 2>&1
say "network time now: $(systemsetup -getusingnetworktime 2>&1 | awk -F': ' '{print $2}')"

# ── T1  back 30 min → fix with sntp -sS (an immediate step from Apple)
say "T1 clock BACK 30 min"
step_by -1800; sleep 4
say "   offset now $(offset)s; fixing with: sntp -sS time.apple.com"
sntp -sS time.apple.com > /dev/null 2>&1; sleep 3
say "   offset after fix $(offset)s"

# ── T2  back 10 min → fix by turning automatic time back ON; how long?
say "T2 clock BACK 10 min"
step_by -600; sleep 4
say "   offset now $(offset)s; fixing with: systemsetup -setusingnetworktime on (then waiting)"
systemsetup -setusingnetworktime on > /dev/null 2>&1
FIXED=""; WAITED=0
for _ in $(seq 1 60); do
    sleep 2; WAITED=$((WAITED + 2))
    o=$(offset)
    if [ -n "$o" ] && awk -v o="$o" 'BEGIN { exit !(o < 1 && o > -1) }'; then
        FIXED=yes; break
    fi
done
if [ -n "$FIXED" ]; then
    say "   timed corrected it by itself within ~${WAITED}s (offset ${o}s)"
else
    say "   NOT corrected after ${WAITED}s (offset ${o}s) — forcing sntp -sS"
    sntp -sS time.apple.com > /dev/null 2>&1
fi
systemsetup -setusingnetworktime off > /dev/null 2>&1

# ── T3  back 5 min → fix from OUR server's server_time (what the agent would do)
say "T3 clock BACK 5 min"
step_by -300; sleep 4
say "   offset now $(offset)s; fixing from server_time at $HEALTH"
SERVER=$(curl -s -m 5 "$HEALTH" | sed -E 's/.*"server_time":"([^"]+)".*/\1/')
if [ -n "$SERVER" ]; then
    EPOCH=$(date -j -u -f "%Y-%m-%dT%H:%M:%S" "${SERVER%.*}" +%s)
    date -f %s "$EPOCH" > /dev/null    # whole seconds only: up to 1 s low, fine for a POC
    sleep 3
    say "   server said $SERVER; offset after fix $(offset)s"
else
    say "   server unreachable — sntp -sS instead"; sntp -sS time.apple.com > /dev/null 2>&1
fi

# ── T4  FORWARD 10 min (past a window end) → fix with sntp
say "T4 clock FORWARD 10 min"
step_by 600; sleep 4
say "   offset now $(offset)s; fixing with sntp -sS"
sntp -sS time.apple.com > /dev/null 2>&1; sleep 3
say "   offset after fix $(offset)s"

# ── T5  time zone → Los Angeles and back: expect NO step
say "T5 time zone → America/Los_Angeles"
systemsetup -settimezone America/Los_Angeles > /dev/null 2>&1; sleep 4
say "   offset now $(offset)s (should be ~0); back to $ORIG_TZ"
systemsetup -settimezone "$ORIG_TZ" > /dev/null 2>&1; sleep 3

# ── T6  sleep ~40 s, wake by itself: continuous vs absolute
if [ "$SLEEP_TEST" = 1 ]; then
    say "T6 SLEEP: the Mac sleeps now and should wake by itself in ~45 s (press a key if not)"
    pmset relative wake 45 > /dev/null 2>&1
    sleep 1
    pmset sleepnow > /dev/null 2>&1
    sleep 75
    say "   awake again"
fi

sleep 3
say "done"
