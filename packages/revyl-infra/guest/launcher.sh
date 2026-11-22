#!/bin/bash
# Started by launchd (ai.openinspect.sandbox) at boot and by start-session.
# Redeems the session bootstrap once, then runs the runtime from the kept
# environment on this and every later boot. Bash 3.2 compatible.
set -euo pipefail

OI_STATE=/Users/computer/.openinspect
OI_BOOTSTRAP_FILE=$OI_STATE/bootstrap
OI_SESSION_FILE=$OI_STATE/session.json
OI_PYTHON=/opt/openinspect/python/bin/python
OI_RUN_RUNTIME=/opt/openinspect/revyl/run-runtime.py
# Matches SANDBOX_BOOTSTRAP_TOKEN_TTL_MS (control-plane src/sandbox/bootstrap.ts).
OI_BOOTSTRAP_WAIT_SECONDS=900
OI_BOOTSTRAP_RETRY_SECONDS=5

log() { printf 'openinspect-launcher: %s\n' "$*" >&2; }

read_value() {
  local key="$1" line
  while IFS= read -r line; do
    case "$line" in "$key="*) printf '%s' "${line#*=}"; return 0 ;; esac
  done <"$OI_BOOTSTRAP_FILE"
  return 1
}

redeem_bootstrap() {
  local url token headers body status deadline
  url="$(read_value OPENINSPECT_BOOTSTRAP_URL)" || { log "bootstrap has no URL"; exit 1; }
  token="$(read_value OPENINSPECT_BOOTSTRAP_TOKEN)" || { log "bootstrap has no token"; exit 1; }
  # A header file keeps the token out of the process list.
  headers="$(mktemp "$OI_STATE/.headers.XXXXXX")"
  body="$(mktemp "$OI_STATE/.session.XXXXXX")"
  printf 'Authorization: Bearer %s\n' "$token" >"$headers"
  deadline=$((SECONDS + OI_BOOTSTRAP_WAIT_SECONDS))
  while :; do
    status="$(curl --silent --show-error --output "$body" --write-out '%{http_code}' \
      --max-time 30 --request POST --header "@$headers" "$url" || true)"
    [ "$status" = 200 ] && break
    case "$status" in
    401 | 403 | 404 | 410)
      rm -f "$headers" "$body" "$OI_BOOTSTRAP_FILE"
      log "bootstrap refused (HTTP $status)"
      exit 1
      ;;
    esac
    if [ "$SECONDS" -ge "$deadline" ]; then
      rm -f "$headers" "$body"
      log "control plane unreachable for ${OI_BOOTSTRAP_WAIT_SECONDS}s (last HTTP ${status:-none})"
      exit 1
    fi
    sleep "$OI_BOOTSTRAP_RETRY_SECONDS"
  done
  rm -f "$headers"
  if ! "$OI_PYTHON" -B "$OI_RUN_RUNTIME" --check "$body"; then
    rm -f "$body"
    log "bootstrap response is not a session environment"
    exit 1
  fi
  mv -f "$body" "$OI_SESSION_FILE"
  rm -f "$OI_BOOTSTRAP_FILE"
  log "session environment received"
}

umask 077
mkdir -p "$OI_STATE"
if [ ! -f "$OI_SESSION_FILE" ] && [ ! -f "$OI_BOOTSTRAP_FILE" ]; then
  log "not a session computer; nothing to start"
  exit 0
fi
[ -f "$OI_SESSION_FILE" ] || redeem_bootstrap
log "starting the runtime"
exec "$OI_PYTHON" -B "$OI_RUN_RUNTIME" --run "$OI_SESSION_FILE"
