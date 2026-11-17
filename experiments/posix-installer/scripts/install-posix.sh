#!/bin/sh
set -eu

# Installs a source-side launcher. It does not start or restart HAPI.
if [ "$#" -ne 2 ]; then printf '%s\n' 'Usage: sh scripts/install-posix.sh /absolute/private-connection-directory /absolute/native-opencode' >&2; exit 2; fi
case "$1" in /*) ;; *) printf '%s\n' 'The connection directory must be absolute.' >&2; exit 2;; esac
case "$2" in /*) ;; *) printf '%s\n' 'The native OpenCode path must be absolute.' >&2; exit 2;; esac
for command in node npm git tar mktemp python3 readlink; do command -v "$command" >/dev/null 2>&1 || { printf '%s\n' "Required command is missing: $command" >&2; exit 1; }; done
[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -ge 24 ] || { printf '%s\n' 'Node.js 24 or later is required.' >&2; exit 1; }
keys=$(CDPATH= cd -P "$1" && pwd -P)
binary_dir=$(CDPATH= cd -P "$(dirname "$2")" && pwd -P)
binary="$binary_dir/$(basename "$2")"
[ -x "$binary" ] || { printf '%s\n' 'Native OpenCode is not executable.' >&2; exit 1; }
for name in connection.json pac-source-token.txt pac-relay-ca.pem; do [ -r "$keys/$name" ] || { printf '%s\n' "Required private connection file is missing: $name" >&2; exit 1; }; done
repo=$(CDPATH= cd -P "$(dirname "$0")/.." && pwd -P)
cd "$repo"
python3 "$repo/scripts/posix-install-safety.py" check
revision=$(git rev-parse --verify HEAD)
case "$revision" in *[!0-9a-f]*|'') printf '%s\n' 'Invalid checkout revision.' >&2; exit 1;; esac
[ "${#revision}" -eq 40 ] || { printf '%s\n' 'Invalid checkout revision.' >&2; exit 1; }
umask 077
base="$HOME/.local/share/pac-bridge-v2"
legacy="$HOME/.local/share/pac-bridge"
if [ -e "$legacy" ] || [ -L "$legacy" ]; then
  printf '%s\n' 'Existing legacy installation requires a separately reviewed migration; no new profile was created.' >&2
  exit 1
fi
if [ -e "$base" ] || [ -L "$base" ]; then
  [ -d "$base" ] && [ ! -L "$base" ] && [ -f "$base/.pac-bridge-install" ] && [ ! -L "$base/.pac-bridge-install" ] || { printf '%s\n' 'Existing installation directory requires review.' >&2; exit 1; }
else
  mkdir -p "$HOME/.local/share"
  mkdir "$base" || { printf '%s\n' 'Installation directory appeared concurrently; review it before retrying.' >&2; exit 1; }
  python3 "$repo/scripts/posix-install-safety.py" sync-dir "$HOME/.local/share"
  printf '%s\n' 'PAC Bridge installation' | python3 "$repo/scripts/posix-install-safety.py" publish "$base/.pac-bridge-install"
fi
exec python3 "$repo/scripts/posix-install-safety.py" lock "$base" "$repo/scripts/install-posix-locked.sh" "$base" "$repo" "$revision" "$keys" "$binary"
