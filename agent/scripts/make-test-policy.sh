#!/usr/bin/env bash
# Install a signed test policy whose window opens a couple of minutes from now,
# so a V-series run does not mean waiting until 21:30 to learn anything.
#
#   sudo agent/scripts/make-test-policy.sh [minutes-ahead] [minutes-long] [lock|shutdown]
#   sudo agent/scripts/make-test-policy.sh 2 3            # opens in 2 min, CLOSES after 3
#   sudo agent/scripts/make-test-policy.sh 2 5 shutdown   # cutover.md §3 — the real power-off
#
# ⚠️ `shutdown` is the ONLY way this script can reach the last rung. The
# ladder escalates only for a window whose action is "shutdown"
# (`Ladder.swift`), so a `lock` window never powers off and never prints the
# safe build's "DEV_ENFORCEMENT: shutdown suppressed" either. With `shutdown`
# the grace is 60 s rather than 300, so the escalation lands inside a short
# window. On the SAFE build it is a log line; on a production build it
# POWERS THE MAC OFF — have `sudo killall shutdown` ready.
#
# ⚠️ Run with sudo — everything under /var/db/homeparentcontrol is root-owned.
# ⚠️ Generates its OWN keypair. This is a test fixture, not the production key;
#    the real one lives in the cluster secret and never touches a laptop.
#
# ★ **The window LENGTH is the safety feature, and it defaults short.**
#
# "Enforcement is the re-locking, not the lock": while the window holds, the
# enforcer re-locks every 60 seconds. On a spare Mac that is fine. On the Mac
# you are typing on it means about 55 usable seconds at a time, which is
# enough to fix things and unpleasant enough to panic in.
#
# A window that CLOSES ON ITS OWN is therefore the primary recovery path —
# it needs no command, no console and no presence of mind. Ten minutes was
# the old default and is long enough to be genuinely stressful; three is
# long enough to watch a lock, a re-lock and a release.
set -euo pipefail

ROOT=/var/db/homeparentcontrol
MINUTES_AHEAD="${1:-2}"
MINUTES_LONG="${2:-3}"
ACTION="${3:-lock}"
case "$ACTION" in
  lock) GRACE_S=300 ;;
  shutdown) GRACE_S=60 ;;
  *) echo "action must be lock or shutdown, not '$ACTION'"; exit 1 ;;
esac

[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
mkdir -p "$ROOT/spool"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
openssl genpkey -algorithm ed25519 -out "$TMP/key.pem" 2>/dev/null

FROM=$(date -v+"${MINUTES_AHEAD}"M +%H:%M)
UNTIL=$(date -v+"$((MINUTES_AHEAD + MINUTES_LONG))"M +%H:%M)
DAY=$(date +%a | tr '[:upper:]' '[:lower:]')
TZNAME=$(readlink /etc/localtime | sed 's|.*/zoneinfo/||')

echo "window: $FROM -> $UNTIL on $DAY, zone $TZNAME, action $ACTION (grace ${GRACE_S}s)"

# Sign it exactly as the server does: compact JWS, EdDSA, kid = RFC 7638
# thumbprint of the public JWK.
# shellcheck disable=SC2016  # the node program is not shell; $ is JS.
node -e '
const c = require("node:crypto"), fs = require("node:fs");
const priv = c.createPrivateKey(fs.readFileSync(process.argv[1]));
const jwk = c.createPublicKey(priv).export({ format: "jwk" });
const kid = c.createHash("sha256")
  .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))
  .digest("base64url");

const doc = {
  policy_version: 1,
  issued_at: new Date().toISOString(),
  not_before: new Date().toISOString(),
  device_id: "018f2a4c-7b31-7c9e-9d2a-3f5b7c1e4a60",
  subject: { child_id: "018f2a4b-6a20-7b8d-8c1f-2e4a6b8d0f31", display_name: "Test" },
  timezone: process.argv[4],
  confirm_immediate_effect: false,
  schedule: { kind: "windows", windows: [{
    id: "018f2a4b-7c31-7d9e-9a2b-3c5d7e9f1a42",
    label: "V-series test window",
    days: [process.argv[5]],
    restricted_from: process.argv[2],
    restricted_until: process.argv[3],
    // ⚠️ `lock` unless asked. Escalation is tested separately and
    // deliberately (cutover.md §3), not as a side effect of every V-row.
    action: process.argv[7],
    action_options: { shutdown_grace_s: Number(process.argv[8]), escalate_after_failures: 3 },
    warnings: [{ lead_minutes: 1, channel: "modal" }],
  }]},
  overrides: [],
};

const b64u = b => Buffer.from(b).toString("base64url");
const header = b64u(JSON.stringify({ alg: "EdDSA", typ: "JOSE", kid }));
const payload = b64u(JSON.stringify(doc));
const sig = c.sign(null, Buffer.from(header + "." + payload), priv);

fs.writeFileSync(process.argv[6] + "/policy.current.json", header + "." + payload + "." + b64u(sig));
fs.writeFileSync(process.argv[6] + "/policy.lkg.json",     header + "." + payload + "." + b64u(sig));
fs.writeFileSync(process.argv[6] + "/policy_signing_keys.json",
  JSON.stringify([{ kid, kty: jwk.kty, crv: jwk.crv, x: jwk.x, alg: "EdDSA", use: "sig" }]));
console.log("kid:", kid);
' "$TMP/key.pem" "$FROM" "$UNTIL" "$TZNAME" "$DAY" "$ROOT" "$ACTION" "$GRACE_S"

chmod 600 "$ROOT"/policy.*.json
chmod 644 "$ROOT/policy_signing_keys.json"
echo "installed under $ROOT"

cat <<RECOVERY

────────────────────────────────────────────────────────────────────────
 The screen will lock at $FROM and RE-LOCK every 60 s until $UNTIL.
 It releases on its own at $UNTIL — that is the recovery that needs
 nothing from you.

 If you want out sooner, from a terminal or over SSH:

   sudo touch $ROOT/DISABLE     ★ use THIS one

 ⚠️ Prefer the kill switch, because it is the only one-liner that stops
 BOTH lockers. \`com.hpc.deadfall\` is a separate LaunchDaemon that sync
 generates from the schedule; it wakes at the window start, re-evaluates
 the whole predicate by itself and locks. So booting out the enforcer
 alone looks like it worked and then the screen locks anyway:

   sudo launchctl bootout system/com.hpc.enforcerd
   sudo launchctl bootout system/com.hpc.deadfall    # ← needs BOTH

 Both read DISABLE first, fresh from disk, before anything else — which
 is exactly why it is the one to reach for under stress.

 ⚠️ A lock is NOT a lockout. It is the normal macOS screen lock and your
 own password clears it. Nothing here can touch your account, FileVault,
 sudoers or Remote Login — the policy schema cannot express any of them
 (A.34), which is structural rather than a promise.

 ⚠️ Remember to remove DISABLE afterwards, or the agent stays off:
   sudo rm -f $ROOT/DISABLE
────────────────────────────────────────────────────────────────────────
RECOVERY
