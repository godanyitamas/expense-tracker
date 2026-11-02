#!/usr/bin/env bash
# Writes clasp credentials from the CLASPRC_JSON environment variable.
# Cloud containers are ephemeral, so this has to run at the start of every session.
set -euo pipefail

if [ -z "${CLASPRC_JSON:-}" ]; then
  echo "CLASPRC_JSON is not set: clasp is not authenticated." >&2
  echo "Add the contents of your local ~/.clasprc.json as the CLASPRC_JSON environment variable." >&2
  exit 1
fi

umask 077
printf '%s' "$CLASPRC_JSON" > "$HOME/.clasprc.json"
clasp show-authorized-user
