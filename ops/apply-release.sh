#!/usr/bin/env bash
set -Eeuo pipefail

app="${APP_DIR:?APP_DIR is required}"
incoming="${INCOMING_DIR:?INCOMING_DIR is required}"
sha="${RELEASE_SHA:?RELEASE_SHA is required}"
project="${PROJECT_NAME:-lilacmacro-services}"

[[ "${sha}" =~ ^[0-9a-f]{40}$ ]] || exit 1
[[ "${app}" == /* && "${incoming}" == /* && "${app}" != / && "${incoming}" != / ]] || exit 1
[[ ! -L "${app}" && ! -L "${incoming}" && -d "${app}" && -d "${incoming}" ]] || exit 1
command -v realpath >/dev/null
command -v flock >/dev/null
app="$(realpath -e -- "${app}")"
incoming="$(realpath -e -- "${incoming}")"
[[ "${app}" != "${incoming}" && "${incoming}/" != "${app}/"* && "${app}/" != "${incoming}/"* ]] || exit 1

state="${app}.__release-state"
previous="${state}/previous"
lock="${state}/deploy.lock"
release_marker='.release-sha'
mkdir -p -- "${state}"
[[ ! -L "${state}" && ! -L "${lock}" && ! -L "${previous}" ]] || exit 1
touch "${lock}"
exec 9>>"${lock}"
flock 9

if [[ -e "${app}/${release_marker}" ]]; then
  [[ -f "${app}/${release_marker}" && ! -L "${app}/${release_marker}" ]] || exit 1
  previous_sha="$(<"${app}/${release_marker}")"
  [[ "${previous_sha}" =~ ^[0-9a-f]{40}$ ]] || exit 1
else
  previous_sha=''
fi
[[ ! -e "${incoming}/${release_marker}" || ( -f "${incoming}/${release_marker}" && ! -L "${incoming}/${release_marker}" ) ]] || exit 1
printf '%s\n' "${sha}" >"${incoming}/${release_marker}"

rm -rf -- "${previous}.building"
mkdir -p -- "${previous}.building"
rsync -a --delete "${app}/" "${previous}.building/"
rm -rf -- "${previous}"
mv -- "${previous}.building" "${previous}"

restore() {
  status=$?
  trap - EXIT
  if [[ "${status}" -ne 0 && -d "${previous}" && ! -L "${previous}" ]]; then
    (cd "${app}" && doppler run -- docker compose --project-name "${project}" down --remove-orphans) || true
    rsync -a --delete "${previous}/" "${app}/"
    if [[ -n "${previous_sha}" ]]; then
      (cd "${app}" && RELEASE_SHA="${previous_sha}" PROJECT_NAME="${project}" bash ops/deploy.sh) || true
    fi
  fi
  exit "${status}"
}
trap restore EXIT

rsync -a --delete "${incoming}/" "${app}/"
(cd "${app}" && RELEASE_SHA="${sha}" PROJECT_NAME="${project}" bash ops/deploy.sh)
trap - EXIT
