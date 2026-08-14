#!/usr/bin/env bash
set -euo pipefail

project="${PROJECT_NAME:-lilacmacro-services}"
release_sha="${RELEASE_SHA:?RELEASE_SHA is required}"
compose=(docker compose --project-name "${project}" -f compose.yml)

[[ "${release_sha}" =~ ^[0-9a-f]{40}$ ]] || { echo "RELEASE_SHA is invalid." >&2; exit 1; }
[[ -f .release-sha && ! -L .release-sha ]] || { echo "Release marker is unavailable." >&2; exit 1; }
recorded_sha="$(<.release-sha)"
[[ "${recorded_sha}" == "${release_sha}" ]] || { echo "Release marker does not match RELEASE_SHA." >&2; exit 1; }
[[ -n "${DOPPLER_TOKEN:-}" ]] || { echo "DOPPLER_TOKEN is required." >&2; exit 1; }
command -v doppler >/dev/null || { echo "Doppler CLI is required." >&2; exit 1; }

doppler run -- bash -c '
  test -n "${PUBLIC_ORIGIN:-}" &&
  test -n "${POSTGRES_PASSWORD:-}" &&
  test -n "${POSTGRES_API_PASSWORD:-}" &&
  test -n "${POSTGRES_CONTROL_PASSWORD:-}" &&
  test -n "${POSTGRES_WORKER_PASSWORD:-}" &&
  test -n "${CLOUDFLARE_TUNNEL_TOKEN:-}"
' || {
  echo "Doppler config is incomplete." >&2
  exit 1
}
doppler run -- "${compose[@]}" config --quiet
doppler run -- "${compose[@]}" build --pull
doppler run -- "${compose[@]}" up -d postgres
doppler run -- env PROJECT_NAME="${project}" bash -c '
  docker compose --project-name "${PROJECT_NAME}" -f compose.yml --profile tools run --rm --no-deps \
    migrator node dist/scripts/provision-db-roles.js
  docker compose --project-name "${PROJECT_NAME}" -f compose.yml --profile tools run --rm --no-deps \
    migrator node dist/scripts/migrate.js
'
doppler run -- "${compose[@]}" up -d --remove-orphans control api bot worker cloudflared
doppler run -- env PROJECT_NAME="${project}" bash ops/verify-runtime.sh
