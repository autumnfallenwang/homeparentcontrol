#!/bin/bash
set -uo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
sfltool dumpbtm > /usr/local/var/hpc-verify/btmdump.txt 2>/dev/null
echo "############ B1 — BTM AFTER REBOOT (the decisive comparison) ############"
echo "---- Mach-O (ad-hoc signed) entry ----"
grep -B2 -A10 "com.hpc.verify$\|16.com.hpc.verify" /usr/local/var/hpc-verify/btmdump.txt | grep -E "Name:|Developer Name:|Type:|Disposition:|Parent Identifier:|Executable" | head -12
echo "---- BASH-script entry (POC 1's design) ----"
grep -B2 -A10 "verifybash" /usr/local/var/hpc-verify/btmdump.txt | grep -E "Name:|Developer Name:|Type:|Disposition:|Parent Identifier:|Executable" | head -12
echo
echo "############ did each auto-load after reboot? ############"
for L in com.hpc.verify com.hpc.verifybash; do
  printf "%-22s " "$L"
  launchctl print "system/$L" 2>/dev/null | grep -E "^\s+state = " || echo "NOT LOADED"
done
echo
echo "############ B3 — SIGTERM at shutdown? ############"
printf "swift probe SIGTERM count: "; grep -c "SIGTERM_RECEIVED" /usr/local/var/hpc-verify/probe.log 2>/dev/null || echo 0
printf "bash  probe SIGTERM count: "; grep -c "BASH_SIGTERM_RECEIVED" /usr/local/var/hpc-verify/probe-bash.log 2>/dev/null || echo 0
echo
echo "############ logs (tail) ############"
echo "--- swift ---"; tail -4 /usr/local/var/hpc-verify/probe.log 2>/dev/null
echo "--- bash  ---"; tail -4 /usr/local/var/hpc-verify/probe-bash.log 2>/dev/null
echo; echo "full dump: /usr/local/var/hpc-verify/btmdump.txt"
