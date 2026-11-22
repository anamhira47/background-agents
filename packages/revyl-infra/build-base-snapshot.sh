#!/usr/bin/env bash
# Builds the Revyl base snapshot new Open-Inspect sessions are created from.
# Needs the revyl CLI signed in (REVYL_API_KEY) for an organization with
# persistent computers enabled, and jq.
# Usage: build-base-snapshot.sh <git URL of this repository> <ref> <snapshot name>
set -euo pipefail

url="${1:?git URL}"
ref="${2:?ref}"
name="${3:?snapshot name}"

id="$(revyl computer create --os macos --persistent --timeout 2h --wait --wait-timeout 10m --json |
  jq -er '.computer_session_id')"
echo "computer $id is running; if this script fails, delete it with: revyl computer delete $id --yes" >&2

revyl computer exec "$id" --timeout 5m -- git clone --depth 1 --branch "$ref" "$url" oi-src
# shellcheck disable=SC2016 # expanded by the guest's shell
revyl computer exec "$id" --timeout 60m -- /bin/zsh -lc \
  'bash oi-src/packages/revyl-infra/guest/install.sh oi-src >oi-install.log 2>&1; s=$?; tail -n 40 oi-install.log; exit $s'
revyl computer exec "$id" --timeout 1m -- rm -rf oi-src oi-install.log

revyl computer stop "$id" --wait --wait-timeout 10m --json >/dev/null
for attempt in $(seq 1 40); do
  if revyl computer snapshot save "$id" --name "$name" --json >/dev/null; then
    echo "REVYL_BASE_SNAPSHOT=$name"
    echo "The source computer is no longer needed: revyl computer delete $id --yes" >&2
    exit 0
  fi
  echo "snapshot not ready (attempt $attempt); its save may still be copying off host" >&2
  sleep 30
done
echo "could not save the snapshot; computer $id is stopped with its disk kept" >&2
exit 1
