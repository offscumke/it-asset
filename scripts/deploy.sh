#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "$script_dir/.." && pwd)"
cd "$project_dir"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose is required" >&2
  exit 1
fi

generate_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    od -An -N "$1" -tx1 /dev/urandom | tr -d ' \n'
  fi
}

if [[ ! -f .env ]]; then
  generated_admin_pass="$(generate_hex 12)"
  generated_agent_secret="$(generate_hex 32)"
  generated_jwt_secret="$(generate_hex 32)"
  umask 077
  {
    echo "COMPOSE_PROJECT_NAME=it-asset"
    echo "APP_BIND=0.0.0.0"
    echo "APP_PORT=${APP_PORT:-3001}"
    echo "IMAGE_TAG=latest"
    echo "ADMIN_USER=admin"
    echo "ADMIN_PASS=$generated_admin_pass"
    echo "AGENT_SECRET=$generated_agent_secret"
    echo "JWT_SECRET=$generated_jwt_secret"
    echo "PUBLIC_BASE_URL=${PUBLIC_BASE_URL:-}"
    echo "TRUST_PROXY=${TRUST_PROXY:-0}"
    echo "CORS_ORIGIN=${CORS_ORIGIN:-}"
  } > .env
  echo "Created .env with generated credentials."
  echo "Admin password: $generated_admin_pass"
fi

docker compose config --quiet
docker compose up -d --build

container_id="$(docker compose ps -q it-asset)"
for attempt in {1..30}; do
  health_status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}starting{{end}}' "$container_id")"
  if [[ "$health_status" == "healthy" ]]; then
    echo "IT Asset is healthy on port ${APP_PORT:-3001}."
    exit 0
  fi
  if [[ "$health_status" == "unhealthy" ]]; then
    docker compose logs --tail=100 it-asset
    exit 1
  fi
  sleep 2
done

docker compose logs --tail=100 it-asset
echo "Timed out waiting for a healthy container" >&2
exit 1
