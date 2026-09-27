#!/bin/bash
# Can a root LaunchDaemon put a warning on the logged-in user's screen?
#
#   sudo tools/verify/warning-from-daemon.sh      (then WATCH THE SCREEN)
#
# ⚠️ Why this exists. On the first on-hardware run (2026-09-26) the enforcer's
# one-minute modal never appeared: `osascript` ran for the full 20 s timeout and
# was killed. The SAME command run from Terminal with sudo showed the dialog at
# once. The difference is context — a Terminal belongs to the user's GUI
# session; a LaunchDaemon does not, and `launchctl asuser` changes only the
# bootstrap namespace. A check from Terminal cannot answer this, so this runs
# the variants from a real (temporary) LaunchDaemon, exactly as the enforcer
# does, and removes it afterwards.
#
# Each variant is labelled on screen. Note which ones you SEE. The log records
# how long each ran and how it ended:
#   exit 0 in ~15 s  → displayed and ignored ("giving up after 15")
#   exit 0 sooner    → displayed and clicked
#   KILLED at 25 s   → hung without ever reaching the screen
#   non-zero, fast   → refused outright (the error is in the log)
set -uo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }

UID_CONSOLE="$(stat -f %u /dev/console)"
USER_CONSOLE="$(stat -f %Su /dev/console)"
[ "$UID_CONSOLE" -ge 501 ] || { echo "no one is logged in at the console"; exit 1; }

DIR=/usr/local/var/hpc-verify
LABEL=com.hpc.verify.warning
PLIST=/Library/LaunchDaemons/$LABEL.plist
mkdir -p "$DIR"
rm -f "$DIR/warning.log"

cat > "$DIR/warning-probe.sh" <<PROBE
#!/bin/bash
run() {
  name="\$1"; shift
  start=\$(date +%s)
  "\$@" >>"$DIR/warning.log" 2>&1 &
  pid=\$!
  for _ in \$(seq 1 25); do kill -0 "\$pid" 2>/dev/null || break; sleep 1; done
  if kill -0 "\$pid" 2>/dev/null; then
    kill "\$pid" 2>/dev/null
    echo "\$name: KILLED after 25s — never finished" >>"$DIR/warning.log"
  else
    wait "\$pid"; rc=\$?
    echo "\$name: exit \$rc after \$(( \$(date +%s) - start ))s" >>"$DIR/warning.log"
  fi
}
DLG='buttons {"OK"} default button 1 giving up after 15 with icon caution'
run "A modal, asuser (what the enforcer does)" \\
  /bin/launchctl asuser $UID_CONSOLE /usr/bin/osascript -e "display dialog \"A — asuser, as root\" with title \"Bedtime\" \$DLG"
run "B modal, asuser + sudo -u (as the user)" \\
  /bin/launchctl asuser $UID_CONSOLE /usr/bin/sudo -u $USER_CONSOLE /usr/bin/osascript -e "display dialog \"B — asuser, as the user\" with title \"Bedtime\" \$DLG"
run "C banner, asuser (what the enforcer does)" \\
  /bin/launchctl asuser $UID_CONSOLE /usr/bin/osascript -e 'display notification "C — banner, asuser, as root" with title "Bedtime"'
run "D banner, asuser + sudo -u (as the user)" \\
  /bin/launchctl asuser $UID_CONSOLE /usr/bin/sudo -u $USER_CONSOLE /usr/bin/osascript -e 'display notification "D — banner, asuser, as the user" with title "Bedtime"'
echo DONE >>"$DIR/warning.log"
PROBE
chmod 755 "$DIR/warning-probe.sh"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$DIR/warning-probe.sh</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
PLIST

echo "── console user: $USER_CONSOLE ($UID_CONSOLE)"
echo "── running four variants from a LaunchDaemon. WATCH THE SCREEN; note which of A B C D you see."
launchctl bootout "system/$LABEL" 2>/dev/null || true
sleep 2
launchctl bootstrap system "$PLIST"

for _ in $(seq 1 150); do grep -q '^DONE' "$DIR/warning.log" 2>/dev/null && break; sleep 1; done

launchctl bootout "system/$LABEL" 2>/dev/null || true
rm -f "$PLIST"

echo
echo "══════ results ══════"
grep -E '^[A-D] |KILLED|execution error|^DONE' "$DIR/warning.log" 2>/dev/null || cat "$DIR/warning.log"
echo
echo "Now tell Claude which of A, B, C, D appeared on screen."
