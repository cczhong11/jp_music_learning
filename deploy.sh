#!/usr/bin/env bash
set -Eeuo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$project_dir"

echo "Stopping the current container..."
docker compose down --remove-orphans

echo "Building a fresh image..."
docker compose build --pull

echo "Starting the new container..."
docker compose up --detach --force-recreate

service_name="jp-song-shadowing"
container_id="$(docker compose ps --quiet "$service_name")"
if [[ -z "$container_id" ]]; then
  echo "Deployment failed: no container was created." >&2
  exit 1
fi

echo "Waiting for the health check..."
for attempt in {1..60}; do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")"
  case "$health" in
    healthy)
      echo "Deployment complete: http://localhost:3009"
      exit 0
      ;;
    unhealthy|exited|dead)
      echo "Deployment failed: container state is $health." >&2
      docker compose logs --tail 100 "$service_name" >&2
      exit 1
      ;;
  esac
  sleep 1
done

echo "Deployment failed: health check timed out." >&2
docker compose logs --tail 100 "$service_name" >&2
exit 1
