#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="homeparentcontrol-postgres"
DB_USER="hpc"
DB_PASSWORD="hpc"
DB_NAME="hpc_dev"
# 5433, not 5432 — homework's dev postgres already claims 5432 on the host.
# Container names never collide; host ports do.
DB_PORT="5433"
PG_IMAGE="postgres:17-alpine"

if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo "✓ ${CONTAINER_NAME} already running on port ${DB_PORT}"
    exit 0
  fi
  echo "Starting existing ${CONTAINER_NAME}..."
  docker start "${CONTAINER_NAME}"
  exit 0
fi

echo "Creating ${CONTAINER_NAME} (${PG_IMAGE}) on port ${DB_PORT}..."
docker run -d \
  --name "${CONTAINER_NAME}" \
  -e POSTGRES_USER="${DB_USER}" \
  -e POSTGRES_PASSWORD="${DB_PASSWORD}" \
  -e POSTGRES_DB="${DB_NAME}" \
  -p "${DB_PORT}:5432" \
  -v "${CONTAINER_NAME}-data:/var/lib/postgresql/data" \
  "${PG_IMAGE}"

echo "Waiting for postgres to be ready..."
for _ in {1..30}; do
  if docker exec "${CONTAINER_NAME}" pg_isready -U "${DB_USER}" -d "${DB_NAME}" >/dev/null 2>&1; then
    echo "✓ ${CONTAINER_NAME} ready on port ${DB_PORT}"
    exit 0
  fi
  sleep 1
done

echo "✗ postgres did not become ready in time" >&2
exit 1
