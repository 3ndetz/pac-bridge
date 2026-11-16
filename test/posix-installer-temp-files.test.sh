#!/bin/sh
set -eu
repo=$(CDPATH= cd -P "$(dirname "$0")/.." && pwd -P)
root=$(mktemp -d "${TMPDIR:-/tmp}/pac-installer-file-safety.XXXXXXXX")
cleanup() { case "$root" in "${TMPDIR:-/tmp}"/pac-installer-file-safety.*) rm -rf "$root";; esac; }
trap cleanup EXIT HUP INT TERM
mkdir -p "$root/home" "$root/keys" "$root/bin" "$root/native"
printf '%s\n' '#!/bin/sh' 'printf "24\n"' > "$root/bin/node"
printf '%s\n' '#!/bin/sh' 'exit 0' > "$root/bin/npm"
printf '%s\n' '#!/bin/sh' 'exit 0' > "$root/native/opencode"
chmod 700 "$root/bin/node" "$root/bin/npm" "$root/native/opencode"
for name in connection.json pac-source-token.txt pac-relay-ca.pem; do printf '%s\n' fixture > "$root/keys/$name"; done
export HOME="$root/home" PATH="$root/bin:$PATH"
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="$repo"
sh "$repo/scripts/install-posix.sh" "$root/keys" "$root/native/opencode" >/dev/null
base="$HOME/.local/share/pac-bridge"
printf '%s\n' 'do-not-overwrite' > "$root/sentinel"
rm "$base/.pac-bridge-install"
ln "$root/sentinel" "$base/.pac-bridge-install"
for name in "$base/bin/pac-posix-launcher.mjs.tmp" "$base/bin/opencode.tmp" "$base/connection-directory.tmp" "$base/opencode-path.tmp" "$base/current.tmp"; do ln "$root/sentinel" "$name"; done
sh "$repo/scripts/install-posix.sh" "$root/keys" "$root/native/opencode" >/dev/null
[ "$(cat "$root/sentinel")" = 'do-not-overwrite' ] || { printf '%s\n' 'A pre-existing hard link was overwritten.' >&2; exit 1; }
printf '%s\n' 'Installer preserved pre-existing hard-linked files.'
