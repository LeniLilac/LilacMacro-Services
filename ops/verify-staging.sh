#!/usr/bin/env bash
set -Eeuo pipefail

project="${PROJECT_NAME:-lilacmacro-services-staging-check}"
release_sha="${RELEASE_SHA:-staging-check}"
api_port="${STAGING_API_PORT:-18110}"
[[ "${project}" =~ ^[a-z][a-z0-9-]{1,62}$ ]] || exit 1
[[ "${release_sha}" =~ ^[a-f0-9-]{1,64}$ ]] || exit 1
[[ "${api_port}" =~ ^[0-9]{4,5}$ ]] || exit 1
(( api_port >= 1024 && api_port <= 65535 )) || exit 1
[[ -f compose.yml && -f ops/apply-release.sh ]] || exit 1

if timeout 1 bash -c "</dev/tcp/127.0.0.1/${api_port}" 2>/dev/null; then
  echo "Staging API port is already in use." >&2
  exit 1
fi

temporary_root="$(mktemp -d /tmp/lilacmacro-services-staging.XXXXXXXX)"
[[ "${temporary_root}" =~ ^/tmp/lilacmacro-services-staging\.[A-Za-z0-9]{8}$ ]]
[[ ! -L "${temporary_root}" ]]
environment_file="${temporary_root}/staging.env"
compose=(docker compose --project-name "${project}" --env-file "${environment_file}" -f compose.yml)

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [[ -f "${environment_file}" ]]; then
    "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  if [[ -d "${temporary_root}" && ! -L "${temporary_root}" && "${temporary_root}" =~ ^/tmp/lilacmacro-services-staging\.[A-Za-z0-9]{8}$ ]]; then
    rm -rf -- "${temporary_root}"
  fi
  exit "${status}"
}
trap cleanup EXIT INT TERM

random_hex() {
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
}

random_base64() {
  head -c 32 /dev/urandom | base64 -w0
}

read -r signing_private signing_public < <(
  docker run --rm node:24.18.1-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7 \
    node -e "const {generateKeyPairSync}=require('node:crypto'); const k=generateKeyPairSync('ed25519'); console.log(k.privateKey.export({format:'der',type:'pkcs8'}).toString('base64')+' '+k.publicKey.export({format:'der',type:'spki'}).toString('base64'))"
)

owner_password="$(random_hex)"
api_password="$(random_hex)"
control_password="$(random_hex)"
worker_password="$(random_hex)"
internal_api="$(random_base64)"
internal_bot="$(random_base64)"
internal_worker="$(random_base64)"
session_key="$(random_base64)"
oauth_key="$(random_base64)"
upload_key="$(random_base64)"
large_upload_key="$(random_base64)"
install_key="$(random_base64)"
network_key="$(random_base64)"

umask 077
cat >"${environment_file}" <<EOF
RELEASE_SHA=${release_sha}
PUBLIC_ORIGIN=https://macro.example.test
CONTROL_SIGNING_PUBLIC_KEY_BASE64=${signing_public}
CONTROL_SIGNING_PRIVATE_KEY_BASE64=${signing_private}
CONTROL_SIGNING_KEY_ID=staging-1
POSTGRES_PASSWORD=${owner_password}
POSTGRES_API_PASSWORD=${api_password}
POSTGRES_CONTROL_PASSWORD=${control_password}
POSTGRES_WORKER_PASSWORD=${worker_password}
INTERNAL_API_TOKEN_BASE64=${internal_api}
INTERNAL_BOT_TOKEN_BASE64=${internal_bot}
INTERNAL_WORKER_TOKEN_BASE64=${internal_worker}
BACKBLAZEBUCKETNAME=staging-unreachable
BACKBLAZES3ENDPOINT=https://s3.us-west-004.backblazeb2.com
BACKBLAZEREGION=us-west-004
BACKBLAZE_API_KEY_ID=staging-api-key
BACKBLAZE_API_APPLICATION_KEY=staging-api-secret
BACKBLAZE_WORKER_KEY_ID=staging-worker-key
BACKBLAZE_WORKER_APPLICATION_KEY=staging-worker-secret
BACKBLAZE_KEY_PREFIX=diagnostics/staging
DISCORD_BOT_TOKEN=staging-unused
DISCORD_BOT_CLIENT_ID=123456789012345678
DISCORD_BOT_CLIENT_SECRET=staging-unused
DISCORD_OAUTH_REDIRECT_URI=https://macro.example.test/auth/discord/callback
MACRO_ADMIN_IDS=123456789012345678
SESSION_CSRF_HMAC_KEY_BASE64=${session_key}
OAUTH_STATE_ENCRYPTION_KEY_BASE64=${oauth_key}
UPLOAD_AUTH_HMAC_KEY_BASE64=${upload_key}
LARGE_UPLOAD_GRANT_HMAC_KEY_BASE64=${large_upload_key}
INSTALL_PSEUDONYM_HMAC_KEY_BASE64=${install_key}
NETWORK_PSEUDONYM_HMAC_KEY_BASE64=${network_key}
CLOUDFLARE_TUNNEL_TOKEN=staging-not-connected
EDGE_SUBNET=10.250.253.0/29
EDGE_API_ADDRESS=10.250.253.2
EDGE_PROXY_ADDRESS=10.250.253.3
API_PUBLISH_PORT=${api_port}
EOF

"${compose[@]}" config --quiet
if ! docker image inspect "lilacmacro-services:${release_sha}" >/dev/null 2>&1; then
  "${compose[@]}" build --pull
fi
"${compose[@]}" up -d postgres

wait_for_health() {
  local service="$1"
  local deadline=$((SECONDS + 90))
  while (( SECONDS < deadline )); do
    local id health
    id="$("${compose[@]}" ps --all -q "${service}")"
    if [[ -n "${id}" && "${id}" != *$'\n'* ]]; then
      health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${id}")"
      [[ "${health}" == healthy ]] && return 0
      [[ "${health}" == unhealthy ]] && break
    fi
    sleep 2
  done
  local failed_id
  failed_id="$("${compose[@]}" ps --all -q "${service}")"
  if [[ -n "${failed_id}" && "${failed_id}" != *$'\n'* ]]; then
    docker logs --tail 80 "${failed_id}" >&2 || true
  fi
  "${compose[@]}" ps >&2
  return 1
}

wait_for_unhealthy() {
  local service="$1"
  local deadline=$((SECONDS + 90))
  while (( SECONDS < deadline )); do
    local id running health
    id="$("${compose[@]}" ps --all -q "${service}")"
    if [[ -n "${id}" && "${id}" != *$'\n'* ]]; then
      running="$(docker inspect --format '{{.State.Running}}' "${id}")"
      health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${id}")"
      [[ "${running}" == true && "${health}" == unhealthy ]] && return 0
      [[ "${running}" == true ]] || break
    fi
    sleep 2
  done
  echo "${service} did not expose its expected unavailable-dependency health failure." >&2
  "${compose[@]}" ps >&2
  return 1
}

wait_for_health postgres
"${compose[@]}" --profile tools run --rm --no-deps \
  migrator node dist/scripts/provision-db-roles.js
"${compose[@]}" --profile tools run --rm --no-deps \
  migrator node dist/scripts/migrate.js

"${compose[@]}" up -d control api worker
wait_for_health control
wait_for_health api
wait_for_unhealthy worker
worker_stop_started=${SECONDS}
"${compose[@]}" stop --timeout 10 worker >/dev/null
(( SECONDS - worker_stop_started <= 12 ))
set +e
timeout 8 "${compose[@]}" exec -T control node -e \
  "fetch('https://example.com').then(()=>process.exit(0),()=>process.exit(17))" >/dev/null 2>&1
control_egress_status=$?
set -e
[[ "${control_egress_status}" -ne 0 && "${control_egress_status}" -ne 124 ]]
curl --fail --silent --show-error "http://127.0.0.1:${api_port}/health/ready" >/dev/null
curl --fail --silent --show-error "http://127.0.0.1:${api_port}/v1/control" >/dev/null

sql_as() {
  local role="$1"
  local password="$2"
  local statement="$3"
  "${compose[@]}" exec -T -e "PGPASSWORD=${password}" postgres \
    psql --host 127.0.0.1 --username "${role}" --dbname lilacmacro \
    --no-psqlrc --set ON_ERROR_STOP=1 --command "${statement}"
}

expect_denied() {
  local role="$1"
  local password="$2"
  local statement="$3"
  if sql_as "${role}" "${password}" "${statement}" >/dev/null 2>&1; then
    echo "${role} unexpectedly executed a denied statement." >&2
    exit 1
  fi
}

sql_as lilacmacro_api "${api_password}" 'SELECT revision FROM control_state;' >/dev/null
expect_denied lilacmacro_api "${api_password}" 'UPDATE control_state SET updated_at = now();'
sql_as lilacmacro_control "${control_password}" \
  'BEGIN; UPDATE control_state SET updated_at = updated_at; ROLLBACK;' >/dev/null
expect_denied lilacmacro_control "${control_password}" 'SELECT * FROM admin_sessions;'
sql_as lilacmacro_worker "${worker_password}" 'SELECT id FROM diagnostic_uploads LIMIT 1;' >/dev/null
expect_denied lilacmacro_worker "${worker_password}" 'SELECT * FROM oauth_attempts;'

"${compose[@]}" exec -T postgres psql --username lilacmacro --dbname lilacmacro \
  --no-psqlrc --set ON_ERROR_STOP=1 --command 'DELETE FROM published_snapshots;' >/dev/null
readiness_code="$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:${api_port}/health/ready")"
[[ "${readiness_code}" == 503 ]]
"${compose[@]}" restart control >/dev/null
wait_for_health control
deadline=$((SECONDS + 30))
until curl --fail --silent "http://127.0.0.1:${api_port}/health/ready" >/dev/null; do
  (( SECONDS < deadline )) || exit 1
  sleep 1
done

rollback_root="${temporary_root}/rollback"
app="${rollback_root}/app"
incoming="${rollback_root}/incoming"
mkdir -p "${app}/ops" "${incoming}/ops"
printf 'old\n' >"${app}/version"
printf 'new\n' >"${incoming}/version"
previous_release_sha="$(printf '1%.0s' {1..40})"
candidate_release_sha="$(printf '0%.0s' {1..40})"
printf '%s\n' "${previous_release_sha}" >"${app}/.release-sha"
cat >"${app}/ops/deploy.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$(cat version)" == old ]]
[[ "${RELEASE_SHA}" == "$(cat .release-sha)" ]]
printf '%s\n' "${RELEASE_SHA}" >rollback-proof
EOF
cat >"${incoming}/ops/deploy.sh" <<'EOF'
#!/usr/bin/env bash
exit 23
EOF
chmod 0755 "${app}/ops/deploy.sh" "${incoming}/ops/deploy.sh"
set +e
APP_DIR="${app}" INCOMING_DIR="${incoming}" RELEASE_SHA="${candidate_release_sha}" \
  PROJECT_NAME="${project}" bash ops/apply-release.sh >/dev/null 2>&1
rollback_status=$?
set -e
[[ "${rollback_status}" == 23 ]]
[[ "$(cat "${app}/version")" == old ]]
[[ "$(cat "${app}/.release-sha")" == "${previous_release_sha}" ]]
[[ "$(cat "${app}/rollback-proof")" == "${previous_release_sha}" ]]

first_app="${rollback_root}/first-app"
first_incoming="${rollback_root}/first-incoming"
fake_bin="${rollback_root}/fake-bin"
mkdir -p "${first_app}/ops" "${first_incoming}/ops" "${fake_bin}"
printf 'pristine\n' >"${first_app}/version"
printf 'candidate\n' >"${first_incoming}/version"
cat >"${first_incoming}/ops/deploy.sh" <<'EOF'
#!/usr/bin/env bash
exit 24
EOF
cat >"${fake_bin}/doppler" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >'${rollback_root}/first-down-proof'
EOF
chmod 0755 "${first_incoming}/ops/deploy.sh" "${fake_bin}/doppler"
set +e
PATH="${fake_bin}:${PATH}" APP_DIR="${first_app}" INCOMING_DIR="${first_incoming}" \
  RELEASE_SHA="${candidate_release_sha}" PROJECT_NAME="${project}" \
  bash ops/apply-release.sh >/dev/null 2>&1
first_status=$?
set -e
[[ "${first_status}" == 24 ]]
[[ "$(cat "${first_app}/version")" == pristine ]]
[[ ! -e "${first_app}/.release-sha" ]]
grep -F -- "docker compose --project-name ${project} down --remove-orphans" \
  "${rollback_root}/first-down-proof" >/dev/null

echo 'Staging migrations, runtime authority, dependency health, readiness recovery, and rollback/first-deploy teardown checks passed.'
