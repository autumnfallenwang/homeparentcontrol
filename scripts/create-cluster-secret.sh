#!/usr/bin/env bash
# Create the homeparentcontrol-secrets Secret in the cluster from a local env
# file.
#
# The chart wires every secret via `secretKeyRef` and never sees plaintext.
# This runs ONCE, out of band, BEFORE the Argo CD Application is committed —
# §9's bootstrap step 3, and `migrate.enabled` must stay false until it has.
#
# Usage:
#   1. bash scripts/create-cluster-secret.sh --generate   # writes ./cluster-secrets.env
#   2. bash scripts/create-cluster-secret.sh              # applies it
#   3. verify: kubectl -n homeparentcontrol get secret homeparentcontrol-secrets
#
# ⚠️ There is no committed `.env.example`: a file with that name trips the
# pre-commit secret scanner for everyone, for ever, over placeholders. The
# key list is in deploy/RUNBOOK.md, and `--generate` produces a correct file
# with real entropy — better than a template someone fills in by hand.
#
# Keys required — they must match the secretKeyRef references in
# deploy/chart/templates/:
#
#   DATABASE_URL        postgres://hpc:<password>@homeparentcontrol-db:5432/homeparentcontrol
#   POSTGRES_PASSWORD   the same password (initdb consumes it)
#   BETTER_AUTH_SECRET  32+ random bytes; signs parent session cookies
#   POLICY_SIGNING_KEY  ⚠️ see below
#
# ⚠️ **POLICY_SIGNING_KEY is the one that cannot be rotated.**
#
# It is the Ed25519 private key every agent's cached policy is verified
# against. The public half is handed to a device ONCE, at enrolment, and
# cached at `/var/db/homeparentcontrol/policy_signing_keys.json`. There is no
# rotation channel in the contract: replacing this key makes every enrolled
# device reject every new policy, fall back to last-known-good, and keep
# enforcing yesterday's rules indefinitely — loudly, but indefinitely.
#
# Losing it is recoverable only by re-enrolling every Mac by hand. Back it up
# somewhere that is not this cluster.
set -euo pipefail

NAMESPACE="${HPC_NS:-homeparentcontrol}"
SECRET_NAME="${HPC_SECRET_NAME:-homeparentcontrol-secrets}"
ENV_FILE="${HPC_SECRET_ENV:-./cluster-secrets.env}"

# ── --generate: fill in the blanks rather than asking a human to invent
#    entropy. A hand-typed signing key is the failure this avoids.
if [ "${1:-}" = "--generate" ]; then
  if [ -f "$ENV_FILE" ]; then
    echo "ERROR: $ENV_FILE already exists. Refusing to overwrite it —" >&2
    echo "       regenerating POLICY_SIGNING_KEY would orphan every enrolled Mac." >&2
    exit 1
  fi
  PASSWORD="$(openssl rand -hex 24)"
  {
    echo "DATABASE_URL=postgres://hpc:${PASSWORD}@homeparentcontrol-db:5432/homeparentcontrol"
    echo "POSTGRES_PASSWORD=${PASSWORD}"
    echo "BETTER_AUTH_SECRET=$(openssl rand -base64 48 | tr -d '\n')"
    # ⚠️ PKCS#8 PEM, newlines collapsed to \n so it survives an env file.
    # `loadSigningKey` expects exactly this and un-escapes it.
    printf 'POLICY_SIGNING_KEY=%s\n' \
      "$(openssl genpkey -algorithm ed25519 | awk '{printf "%s\\n", $0}')"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "Wrote $ENV_FILE (mode 600)."
  echo
  echo "⚠️  BACK UP POLICY_SIGNING_KEY NOW, somewhere that is not this cluster."
  echo "    It cannot be rotated: every enrolled Mac would reject every policy"
  echo "    and keep enforcing its last-known-good rules for ever."
  exit 0
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found." >&2
  echo "       Run: bash scripts/create-cluster-secret.sh --generate" >&2
  echo "       (the key list is in deploy/RUNBOOK.md step 1)" >&2
  exit 1
fi

# ── Refuse to create a half-populated Secret. A missing key does not fail at
#    apply time; it fails when the API pod starts, as a CreateContainerConfigError
#    that reads like an image problem.
missing=0
for key in DATABASE_URL POSTGRES_PASSWORD BETTER_AUTH_SECRET POLICY_SIGNING_KEY; do
  if ! grep -qE "^${key}=.+" "$ENV_FILE"; then
    echo "ERROR: $key is missing or empty in $ENV_FILE" >&2
    missing=1
  fi
done
[ "$missing" -eq 0 ] || exit 1

# ⚠️ The password in DATABASE_URL and POSTGRES_PASSWORD must match, or initdb
# seeds one password and the API connects with another — which presents as an
# API CrashLoopBackOff with `password authentication failed`, hours after the
# database looked fine.
url_password="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | sed -E 's|.*://[^:]+:([^@]+)@.*|\1|')"
raw_password="$(grep -E '^POSTGRES_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)"
if [ "$url_password" != "$raw_password" ]; then
  echo "ERROR: the password in DATABASE_URL does not match POSTGRES_PASSWORD." >&2
  echo "       initdb would seed one and the API would connect with the other." >&2
  exit 1
fi

kubectl get namespace "$NAMESPACE" >/dev/null 2>&1 \
  || kubectl create namespace "$NAMESPACE"

# Idempotent: `--dry-run=client | apply` keeps this compatible with Argo's
# server-side sync rather than fighting it.
kubectl create secret generic "$SECRET_NAME" \
  --namespace="$NAMESPACE" \
  --from-env-file="$ENV_FILE" \
  --dry-run=client -o yaml \
  | kubectl apply -f -

echo
echo "Created/updated $NAMESPACE/$SECRET_NAME"
echo "Keys present:"
# shellcheck disable=SC2016  # $k/$v are Go template variables, not shell ones —
# they must reach kubectl unexpanded.
kubectl -n "$NAMESPACE" get secret "$SECRET_NAME" -o go-template='{{range $k, $v := .data}}{{$k}}{{"\n"}}{{end}}'
echo
echo "Next: flip migrate.enabled=true in the Argo CD Application (bootstrap step 5)."
