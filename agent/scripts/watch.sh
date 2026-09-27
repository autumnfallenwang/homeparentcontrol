#!/usr/bin/env bash
# Watch the agent decide, on the Mac itself.
#
#   sudo agent/scripts/watch.sh          (ctrl-C to stop)
#
# ⚠️ NOT `log stream`. The agent never writes to os_log — there is no
# `os_log` or `Logger` anywhere in it — so `log stream --predicate 'process ==
# "hpc-enforcerd"'`, which the docs used to recommend, shows nothing at all
# and looks exactly like a dead agent. Found on the first real smoke test.
# What the enforcer actually writes:
#
#   spool/enforcer.ndjson   one line per decision (warning, lock, shutdown).
#                           Sync renames it away every tick, hence `tail -F`.
#   enforcer.health         {ts, tick_seq, version, last_decision} per tick
#   /var/log/hpc-enforcerd.log   stderr — where the safe build prints
#                           "DEV_ENFORCEMENT: shutdown suppressed"
set -uo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run with sudo — everything here is root-only"; exit 1; }
ROOT=/var/db/homeparentcontrol

echo "installed build : $(/usr/local/libexec/hpc-enforcerd --version 2>/dev/null || echo 'not installed')"
echo "base url        : $(cat "$ROOT/base_url" 2>/dev/null || echo '(none — sync cannot reach anything)')"
echo "sync            : $(cat "$ROOT/sync.health" 2>/dev/null || echo '(no sync.health yet)')"
[ -f "$ROOT/DISABLE" ] && echo "⚠️  $ROOT/DISABLE exists — the kill switch is ON; nothing will lock."
echo

tail -n 0 -F "$ROOT/spool/enforcer.ndjson" /var/log/hpc-enforcerd.log 2>/dev/null &
TAIL=$!
trap 'kill "$TAIL" 2>/dev/null' EXIT

LAST=""
while true; do
  HEALTH="$(cat "$ROOT/enforcer.health" 2>/dev/null)"
  if [ "$HEALTH" != "$LAST" ]; then
    printf '%s  enforcer.health %s\n' "$(date +%H:%M:%S)" "${HEALTH:-(missing)}"
    LAST="$HEALTH"
  fi
  sleep 5
done
