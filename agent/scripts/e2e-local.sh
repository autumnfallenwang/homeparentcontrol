#!/usr/bin/env bash
# The real Swift agent against a real local control plane.
#
# Milestone 03's first exit criterion — "the agent enrols against the local
# control plane and exchanges its one-time token for a durable credential" —
# plus the tick, the policy signature, telemetry idempotency and credential
# rotation. No mocks: this drives the shipping `Client`, `Queue` and
# `DeviceState` over a socket against Hono and Postgres.
#
# ⚠️ What it does NOT cover is the daemon's own plumbing, because `Paths`
# points at /var/db/homeparentcontrol and writing there needs root. That is
# the V-series' job, on hardware. This covers the protocol.
#
# Needs: the dev Postgres up, and apps/api/.env with DATABASE_URL.
#
#   ./agent/scripts/e2e-local.sh
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$PWD"
# ⚠️ Absolute. `pnpm --filter` runs with the cwd set to the package directory,
# so every relative path handed to it resolves against apps/api and not here.
ENV_FILE="$ROOT/apps/api/.env"
[ -f "$ENV_FILE" ] || { echo "no $ENV_FILE — cannot reach a database"; exit 1; }

PORT="${HPC_E2E_PORT:-3199}"
BASE_URL="http://127.0.0.1:${PORT}/api/agent/v1/"

# ⚠️ An EPHEMERAL signing key, generated per run and never written to disk.
# The e2e enrols, is handed this key's public half, and verifies a policy
# against it — so the signing path is exercised end to end without the run
# depending on, or leaking, the real POLICY_SIGNING_KEY.
SIGNING_KEY="$(openssl genpkey -algorithm ed25519)"

echo "── starting the API on :${PORT}"
POLICY_SIGNING_KEY="$SIGNING_KEY" API_PORT="$PORT" \
  pnpm --filter @hpc/api exec tsx --env-file="$ENV_FILE" "$ROOT/apps/api/src/index.ts" \
  > /tmp/hpc-e2e-api.log 2>&1 &
API_PID=$!
# ⚠️ Kill the whole group. `tsx` spawns a child, and killing only the wrapper
# leaves the listener holding the port — so the NEXT run fails to bind and
# silently tests the previous build.
cleanup() { kill -- "-$API_PID" 2>/dev/null || kill "$API_PID" 2>/dev/null || true; }
trap cleanup EXIT

for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/agent/v1/health" >/dev/null 2>&1; then break; fi
  sleep 0.4
done
if ! curl -fsS "http://127.0.0.1:${PORT}/api/agent/v1/health" >/dev/null 2>&1; then
  echo "the API never came up:"; tail -30 /tmp/hpc-e2e-api.log; exit 1
fi

echo "── seeding a household and an enrolment code"
SEED="$(pnpm --filter @hpc/api exec tsx --env-file="$ENV_FILE" \
        "$ROOT/apps/api/src/scripts/seed-e2e.ts" | grep '^HPC_E2E_')"
eval "$SEED"
export HPC_E2E_CODE HPC_E2E_DEVICE_ID
export HPC_E2E_BASE_URL="$BASE_URL"
echo "   device ${HPC_E2E_DEVICE_ID}, code ${HPC_E2E_CODE}"

# ⚠️ Each test that enrols consumes the code, and a code is single-use, so
# the suite reseeds per test rather than sharing one.
#
# ⚠️ And then it has to WAIT. §5.8 puts a hard limiter on `/enroll` alone —
# 5/min/IP, 20/h — and every one of these runs from 127.0.0.1. Without the
# pause, tests five onward get a 429 that looks like a protocol bug and is
# actually the limiter working. That is worth knowing: this script is also
# the only place the enrol limiter is exercised against a real socket.
PACE="${HPC_E2E_PACE_S:-14}"

echo "── running the end-to-end suite (pacing ${PACE}s for the /enroll limiter)"
STATUS=0
FIRST=1
for test_name in \
  "enrols" \
  "codeIsSingleUse" \
  "syncs" \
  "policyVerifies" \
  "eventsAreIdempotent" \
  "rotates" \
  "badCredentialHaltsSyncOnly" \
  "drainsAfterAnOutage" \
  "unreachableIsNotAnAction"
do
  if [ "$FIRST" -eq 0 ]; then sleep "$PACE"; fi
  FIRST=0

  SEED="$(pnpm --filter @hpc/api exec tsx --env-file="$ENV_FILE" \
          "$ROOT/apps/api/src/scripts/seed-e2e.ts" | grep '^HPC_E2E_')"
  eval "$SEED"
  export HPC_E2E_CODE HPC_E2E_DEVICE_ID
  # ⚠️ Capture once. Re-running the test to print its failure would enrol a
  # SECOND time with a now-consumed code, and every failure would report
  # `enrolment-code-consumed` instead of what actually went wrong.
  OUTPUT="$(swift test --package-path agent --filter "EndToEnd.*Tests/$test_name" 2>&1 || true)"
  if printf '%s' "$OUTPUT" | grep -q "Test run with .* passed"; then
    echo "   PASS  $test_name"
  else
    echo "   FAIL  $test_name"
    printf '%s' "$OUTPUT" | grep -E "recorded an issue" | head -3 | sed 's/^/         /'
    STATUS=1
  fi
done

echo "── API log tail"
tail -5 /tmp/hpc-e2e-api.log
exit "$STATUS"
