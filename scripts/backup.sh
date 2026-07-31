#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "$script_dir/.." && pwd)"
backup_dir="$project_dir/backups"
timestamp="$(date '+%Y%m%d-%H%M%S')"
backup_path="$backup_dir/assets-$timestamp.db"
cd "$project_dir"

container_id="$(docker compose ps -q it-asset)"
if [[ -z "$container_id" ]]; then
  echo "it-asset container does not exist" >&2
  exit 1
fi

mkdir -p "$backup_dir"
was_running="$(docker inspect --format '{{.State.Running}}' "$container_id")"

restart_service() {
  if [[ "$was_running" == "true" ]]; then
    docker compose start it-asset >/dev/null
  fi
}
trap restart_service EXIT

if [[ "$was_running" == "true" ]]; then
  docker compose stop it-asset >/dev/null
fi
docker compose cp it-asset:/data/assets.db "$backup_path"

echo "Backup created: $backup_path"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$backup_path"
else
  shasum -a 256 "$backup_path"
fi
