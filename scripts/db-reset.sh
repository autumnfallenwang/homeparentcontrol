#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="homeparentcontrol-postgres"
DB_USER="hpc"
DB_NAME="hpc_dev"

echo "⚠ This will DROP and recreate the ${DB_NAME} database."
read -p "Continue? [y/N] " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

docker exec "${CONTAINER_NAME}" psql -U "${DB_USER}" -d postgres -c "DROP DATABASE IF EXISTS ${DB_NAME};"
docker exec "${CONTAINER_NAME}" psql -U "${DB_USER}" -d postgres -c "CREATE DATABASE ${DB_NAME};"
echo "✓ ${DB_NAME} reset"
