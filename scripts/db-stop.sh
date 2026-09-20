#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="homeparentcontrol-postgres"

if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  echo "Stopping ${CONTAINER_NAME}..."
  docker stop "${CONTAINER_NAME}"
  echo "✓ stopped"
else
  echo "${CONTAINER_NAME} is not running"
fi
