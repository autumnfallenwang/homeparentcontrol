#!/bin/bash
# The naive bash probe used `sleep 30` in a loop, so bash deferred the SIGTERM
# trap until sleep returned -> launchd SIGKILLed it and the job is now dead.
# Rewrite with the interruptible `sleep & wait` idiom, which lets bash run the
# trap immediately, then re-bootstrap. This makes the reboot test a fair
# comparison: correctly-written bash vs Mach-O.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }

cat > /usr/local/libexec/hpc-verify/probe.sh <<'BASH'
#!/bin/bash
LOG=/usr/local/var/hpc-verify/probe-bash.log
echo "$(date -u +%FT%TZ) BASH_START euid=$EUID pid=$$" >> "$LOG"
trap 'echo "$(date -u +%FT%TZ) BASH_SIGTERM_RECEIVED" >> "$LOG"; exit 0' TERM
# `sleep & wait` is interruptible: bash runs the trap immediately on SIGTERM.
while true; do sleep 30 & wait $!; echo "$(date -u +%FT%TZ) bash_tick" >> "$LOG"; done
BASH
chmod 755 /usr/local/libexec/hpc-verify/probe.sh
chown root:wheel /usr/local/libexec/hpc-verify/probe.sh

echo "== clearing the wedged job and re-bootstrapping =="
launchctl bootout system/com.hpc.verifybash 2>/dev/null || true
launchctl kill SIGKILL system/com.hpc.verifybash 2>/dev/null || true
launchctl bootstrap system /Library/LaunchDaemons/com.hpc.verifybash.plist 2>/dev/null || true
sleep 3

echo; echo "== SIGTERM responsiveness test (should be immediate, not 30s) =="
P=$(pgrep -f "probe.sh" | head -1)
if [ -n "${P:-}" ]; then
  echo "bash probe pid=$P — sending SIGTERM, expecting trap within 2s"
  kill -TERM "$P"; sleep 2
  grep -c "BASH_SIGTERM_RECEIVED" /usr/local/var/hpc-verify/probe-bash.log 2>/dev/null \
    && echo "   -> trap FIRED promptly (KeepAlive will restart it)" \
    || echo "   -> trap did NOT fire in 2s"
  sleep 3
else
  echo "   bash probe not found after bootstrap"
fi

echo; echo "== final state of both daemons =="
for L in com.hpc.verify com.hpc.verifybash; do
  printf "%-22s " "$L"; launchctl print "system/$L" 2>/dev/null | grep -E "^\s+state = " | head -1 || echo "NOT LOADED"
done
echo; pgrep -fl "probe.sh" || echo "WARNING: no probe.sh process"
pgrep -fl "hpc-verify/probe$" || true
echo; echo "== logs =="; ls -la /usr/local/var/hpc-verify/
echo; echo "=== if BOTH daemons are running above, REBOOT NOW ==="
