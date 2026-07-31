#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 /path/to/assets.db" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "$script_dir/.." && pwd)"
source_db="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
cd "$project_dir"

if [[ ! -f "$source_db" ]]; then
  echo "database not found: $source_db" >&2
  exit 1
fi
if [[ -n "$(docker compose ps --status running -q it-asset)" ]]; then
  echo "stop it-asset before importing a database" >&2
  exit 1
fi

docker compose create it-asset >/dev/null
container_id="$(docker compose ps -a -q it-asset)"
volume_name="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$container_id")"
image_id="$(docker inspect --format '{{.Image}}' "$container_id")"

if [[ -z "$volume_name" ]]; then
  echo "could not resolve the /data volume" >&2
  exit 1
fi

source_dir="$(dirname "$source_db")"
source_name="$(basename "$source_db")"
docker run --rm --user 0 \
  -e SOURCE_DB_NAME="$source_name" \
  -v "$volume_name:/data" \
  -v "$source_dir:/source:ro" \
  "$image_id" \
  sh -c 'cp "/source/$SOURCE_DB_NAME" /data/assets.db && chown 1000:1000 /data/assets.db'

echo "Imported database into volume: $volume_name"
echo "Start the service with: docker compose up -d"
