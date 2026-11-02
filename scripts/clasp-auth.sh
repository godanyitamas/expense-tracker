#!/usr/bin/env bash
# Writes clasp credentials from an environment variable.
# Cloud containers are ephemeral, so this has to run at the start of every session.
#   CLASPRC_B64  - base64 of ~/.clasprc.json (preferred: survives env-var parsers)
#   CLASPRC_JSON - raw contents of ~/.clasprc.json
set -euo pipefail

umask 077
if [ -n "${CLASPRC_B64:-}" ]; then
  printf '%s' "$CLASPRC_B64" | tr -d '[:space:]' | base64 -d > "$HOME/.clasprc.json"
elif [ -n "${CLASPRC_JSON:-}" ]; then
  printf '%s' "$CLASPRC_JSON" > "$HOME/.clasprc.json"
else
  echo "Neither CLASPRC_B64 nor CLASPRC_JSON is set: clasp is not authenticated." >&2
  exit 1
fi
clasp show-authorized-user
