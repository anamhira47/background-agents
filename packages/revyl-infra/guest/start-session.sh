#!/bin/bash
# Run once per session through the Revyl exec API by the control plane.
# Reads the bootstrap URL and single-use token from stdin (never argv), keeps
# them for the launcher, and starts the launcher now.
set -euo pipefail
umask 077

OI_STATE=/Users/computer/.openinspect
IFS= read -r url
IFS= read -r token
case "$url" in https://*) ;; *) echo "bootstrap URL must be https" >&2; exit 2 ;; esac
case "$token" in "" | *[!A-Za-z0-9_-]*) echo "bootstrap token is malformed" >&2; exit 2 ;; esac

mkdir -p "$OI_STATE"
rm -f "$OI_STATE/session.json" "$OI_STATE/boot-complete"
printf 'OPENINSPECT_BOOTSTRAP_URL=%s\nOPENINSPECT_BOOTSTRAP_TOKEN=%s\n' "$url" "$token" >"$OI_STATE/bootstrap"
sudo -n /bin/launchctl kickstart -k system/ai.openinspect.sandbox
