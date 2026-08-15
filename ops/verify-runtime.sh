#!/usr/bin/env bash
set -euo pipefail

project="${PROJECT_NAME:?PROJECT_NAME is required}"
compose=(docker compose --project-name "${project}" -f compose.yml)
services=(postgres control api bot worker cloudflared)
deadline=$((SECONDS + 120))

for service in "${services[@]}"; do
  [[ "${service}" =~ ^[a-z][a-z0-9-]*$ ]] || exit 1
done

while (( SECONDS < deadline )); do
  ready=true
  for service in "${services[@]}"; do
    id="$("${compose[@]}" ps --all -q "${service}")"
    if [[ -z "${id}" || "${id}" == *$'\n'* ]]; then
      ready=false
      continue
    fi
    running="$(docker inspect --format '{{.State.Running}}' "${id}")"
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${id}")"
    if [[ "${running}" != true || "${health}" == unhealthy ]]; then
      docker logs --tail 80 "${id}" >&2 || true
      exit 1
    fi
    [[ "${health}" == healthy ]] || ready=false
  done
  [[ "${ready}" == true ]] && break
  sleep 2
done

if (( SECONDS >= deadline )); then
  "${compose[@]}" ps >&2
  exit 1
fi

ids=()
restarts=()
for service in "${services[@]}"; do
  id="$("${compose[@]}" ps -q "${service}")"
  ids+=("${id}")
  restarts+=("$(docker inspect --format '{{.RestartCount}}' "${id}")")
done
sleep 15
for index in "${!services[@]}"; do
  service="${services[$index]}"
  id="$("${compose[@]}" ps -q "${service}")"
  [[ "${id}" == "${ids[$index]}" ]] || exit 1
  [[ "$(docker inspect --format '{{.RestartCount}}' "${id}")" == "${restarts[$index]}" ]] || exit 1
  [[ "$(docker inspect --format '{{.State.Health.Status}}' "${id}")" == healthy ]] || exit 1
done

"${compose[@]}" exec -T api node dist/scripts/verify-control-snapshot.js

origin="${PUBLIC_ORIGIN:?PUBLIC_ORIGIN is required}"
[[ "${origin}" == https://* ]] || { echo "PUBLIC_ORIGIN must use HTTPS." >&2; exit 1; }
curl --fail --silent --show-error --max-time 20 --proto '=https' --tlsv1.2 \
  --output /dev/null "${origin}/health/ready"

echo "LilacMacro Services are ready and stable."
