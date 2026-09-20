#!/usr/bin/env bash
# Install a signed test policy whose window opens a couple of minutes from now,
# so a V-series run does not mean waiting until 21:30 to learn anything.
#
# ⚠️ Run with sudo — everything under /var/db/homeparentcontrol is root-owned.
# ⚠️ Generates its OWN keypair. This is a test fixture, not the production key;
#    the real one lives in the cluster secret and never touches a laptop.
set -euo pipefail

ROOT=/var/db/homeparentcontrol
MINUTES_AHEAD="${1:-2}"

[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
mkdir -p "$ROOT/spool"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
openssl genpkey -algorithm ed25519 -out "$TMP/key.pem" 2>/dev/null

FROM=$(date -v+${MINUTES_AHEAD}M +%H:%M)
UNTIL=$(date -v+1H +%H:%M)
DAY=$(date +%a | tr '[:upper:]' '[:lower:]')
TZNAME=$(readlink /etc/localtime | sed 's|.*/zoneinfo/||')

echo "window: $FROM -> $UNTIL on $DAY, zone $TZNAME"

# Sign it exactly as the server does: compact JWS, EdDSA, kid = RFC 7638
# thumbprint of the public JWK.
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
    // ⚠️ `lock`, never `shutdown`. Escalation is tested separately and
    // deliberately, not as a side effect of every other row in the matrix.
    action: "lock",
    action_options: { shutdown_grace_s: 300, escalate_after_failures: 3 },
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
' "$TMP/key.pem" "$FROM" "$UNTIL" "$TZNAME" "$DAY" "$ROOT"

chmod 600 "$ROOT"/policy.*.json
chmod 644 "$ROOT/policy_signing_keys.json"
echo "installed under $ROOT"
