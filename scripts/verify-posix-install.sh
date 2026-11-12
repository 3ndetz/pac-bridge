#!/bin/sh
set -eu

# Synthetic, local-only installer check. It never launches HAPI or contacts a PAC.
repo=$(CDPATH= cd -P "$(dirname "$0")/.." && pwd -P)
root=$(mktemp -d "${TMPDIR:-/tmp}/pac-posix-proof.XXXXXXXX")
cleanup() { case "$root" in "${TMPDIR:-/tmp}"/pac-posix-proof.*) [ ! -d "$root" ] || rm -rf "$root";; esac; }
trap cleanup EXIT HUP INT TERM
mkdir -p "$root/home" "$root/keys" "$root/other-keys" "$root/native"
printf '%s\n' '{"relayUrl":"wss://example.invalid:443","pacName":"testpac","controllerCwd":"/controller"}' > "$root/keys/connection.json"
printf '%s\n' 'synthetic-token' > "$root/keys/pac-source-token.txt"
printf '%s\n' 'synthetic-certificate' > "$root/keys/pac-relay-ca.pem"
cp "$root/keys/connection.json" "$root/other-keys/connection.json"
cp "$root/keys/pac-source-token.txt" "$root/other-keys/pac-source-token.txt"
cp "$root/keys/pac-relay-ca.pem" "$root/other-keys/pac-relay-ca.pem"
printf '%s\n' '#!/bin/sh' 'printf "native-opencode-fixture\n"' > "$root/native/opencode"
chmod 700 "$root/native/opencode"
export HOME="$root/home"
unset NODE_EXTRA_CA_CERTS
git config --global --add safe.directory "$repo"
cd "$repo"
sh scripts/install-posix.sh "$root/keys" "$root/native/opencode"
sh scripts/install-posix.sh "$root/keys" "$root/native/opencode"
base="$HOME/.local/share/pac-bridge"
before=$(cat "$base/current")
[ "$("$base/bin/opencode" --version)" = 'native-opencode-fixture' ]
if sh scripts/install-posix.sh "$root/other-keys" "$root/native/opencode" >/dev/null 2>&1; then printf '%s\n' 'A conflicting connection directory was accepted.' >&2; exit 1; fi
[ "$(cat "$base/current")" = "$before" ]
mkdir -p "$root/unmanaged/.local/share/pac-bridge"
printf '%s\n' 'keep' > "$root/unmanaged/.local/share/pac-bridge/sentinel"
if HOME="$root/unmanaged" sh scripts/install-posix.sh "$root/keys" "$root/native/opencode" >/dev/null 2>&1; then printf '%s\n' 'An unmanaged installation directory was accepted.' >&2; exit 1; fi
[ "$(cat "$root/unmanaged/.local/share/pac-bridge/sentinel")" = 'keep' ]
printf '%s\n' 'POSIX installation, repeat installation, command forwarding and conflict protection passed.'
