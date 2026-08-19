#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 /path/to/assets.db [/path/to/attachments.tar.gz]" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "$script_dir/.." && pwd)"
source_db="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
source_attachments=""
if [[ $# -eq 2 ]]; then
  source_attachments="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
  if [[ ! -f "$source_attachments" ]]; then
    echo "attachments archive not found: $source_attachments" >&2
    exit 1
  fi
fi
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
if [[ -n "$source_attachments" ]]; then
  attachments_dir="$(dirname "$source_attachments")"
  attachments_name="$(basename "$source_attachments")"
  docker run --rm --user 0 \
    -e SOURCE_DB_NAME="$source_name" \
    -e SOURCE_ATTACHMENTS_NAME="$attachments_name" \
    -v "$volume_name:/data" \
    -v "$source_dir:/source:ro" \
    -v "$attachments_dir:/attachments:ro" \
    "$image_id" \
    sh -c 'cp "/source/$SOURCE_DB_NAME" /data/assets.db; rm -rf /data/uploads; tar -xzf "/attachments/$SOURCE_ATTACHMENTS_NAME" -C /data; chown -R 1000:1000 /data/assets.db /data/uploads'
else
  docker run --rm --user 0 \
    -e SOURCE_DB_NAME="$source_name" \
    -v "$volume_name:/data" \
    -v "$source_dir:/source:ro" \
    "$image_id" \
    sh -c 'cp "/source/$SOURCE_DB_NAME" /data/assets.db && chown 1000:1000 /data/assets.db'
fi

echo "Imported database into volume: $volume_name"
if [[ -n "$source_attachments" ]]; then echo "Imported attachments into volume: $volume_name"; fi
echo "Start the service with: docker compose up -d"
