#!/bin/sh
# Start a bridge client inside a container that already carries opencode, WITHOUT touching the
# container's own processes: a second `opencode serve` on its own port, in its own directory,
# with the plugin, and woken once so the plugin actually loads.
#
#   sh infra/bridge/client-up.sh <container> <client-name> <dir-in-container> <same-dir-on-this-host>
#
# The token is read from $PAC_SECRETS/<client-name>.token (bridge.env) and never printed.
#
# Three traps this script exists to avoid, each met on 2026-09-22 (README.md):
#   - opencode loads plugins lazily, so an untouched server never connects: it is woken with GET /config;
#   - a plugin that fails to import is dropped in silence: it is import-checked first with the Bun
#     that opencode's binary carries (BUN_BE_BUN=1);
#   - `pkill -f "<pattern>"` run through `sh -c` kills its own shell, whose command line holds the
#     same pattern: the pattern is bracketed so it cannot match itself.
#
# This is the install for a container on this host until the project installs the plugin itself.
set -eu
CT=$1 NAME=$2 DIR=$3 HOSTDIR=$4
PORT=${PAC_CLIENT_PORT:-4097}
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
BRIDGE_DIR=$HERE
[ -f "$HERE/bridge.env" ] && . "$HERE/bridge.env"
TOKEN_FILE="${PAC_SECRETS:-/nonexistent}/$NAME.token"
[ -f "$TOKEN_FILE" ] || { echo "no client token for $NAME at $TOKEN_FILE (PAC_SECRETS in bridge.env)" >&2; exit 1; }

mkdir -p "$HOSTDIR/.opencode/plugin"
cp "$HERE/plugin/pac-bridge.js" "$HOSTDIR/.opencode/plugin/pac-bridge.js"
MSYS_NO_PATHCONV=1 docker exec -w /tmp "$CT" sh -c "BUN_BE_BUN=1 opencode -e \"import('$DIR/.opencode/plugin/pac-bridge.js').then(m => console.log('plugin imports:', Object.keys(m).join(',')))\""

MSYS_NO_PATHCONV=1 docker exec "$CT" sh -c "pkill -f '[o]pencode serve --port $PORT' || true"
MSYS_NO_PATHCONV=1 docker exec -d -w "$DIR" \
  -e PAC_BRIDGE_URL="${PAC_BRIDGE_URL:-ws://pac-bridge:8790/client}" \
  -e PAC_CLIENT_NAME="$NAME" -e PAC_CLIENT_TOKEN="$(cat "$TOKEN_FILE")" \
  -e XDG_DATA_HOME=/tmp/pacbridge-xdg/data -e XDG_STATE_HOME=/tmp/pacbridge-xdg/state \
  "$CT" sh -c "opencode serve --port $PORT --hostname 127.0.0.1 --print-logs > /tmp/pacbridge-serve.log 2>&1"

i=0
until MSYS_NO_PATHCONV=1 docker exec "$CT" sh -c "curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/config" 2>/dev/null | grep -q 200; do
  i=$((i + 1)); [ $i -gt 60 ] && { echo "opencode did not answer on $PORT" >&2; exit 1; }; sleep 3
done
i=0
until MSYS_NO_PATHCONV=1 docker exec "$CT" grep -q "connected to" /tmp/pacbridge-serve.log 2>/dev/null; do
  i=$((i + 1)); [ $i -gt 90 ] && { echo "the plugin never connected; see /tmp/pacbridge-serve.log in $CT" >&2; exit 1; }; sleep 2
done
MSYS_NO_PATHCONV=1 docker exec "$CT" grep "\[pac-bridge\]" /tmp/pacbridge-serve.log
