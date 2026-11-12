#!/bin/sh
set -eu

# Installs a source-side launcher. It does not start or restart HAPI.
if [ "$#" -ne 2 ]; then printf '%s\n' 'Usage: sh scripts/install-posix.sh /absolute/private-connection-directory /absolute/native-opencode' >&2; exit 2; fi
case "$1" in /*) ;; *) printf '%s\n' 'The connection directory must be absolute.' >&2; exit 2;; esac
case "$2" in /*) ;; *) printf '%s\n' 'The native OpenCode path must be absolute.' >&2; exit 2;; esac
for command in node npm git tar mktemp; do command -v "$command" >/dev/null 2>&1 || { printf '%s\n' "Required command is missing: $command" >&2; exit 1; }; done
[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -ge 24 ] || { printf '%s\n' 'Node.js 24 or later is required.' >&2; exit 1; }
keys=$(CDPATH= cd -P "$1" && pwd -P)
binary_dir=$(CDPATH= cd -P "$(dirname "$2")" && pwd -P)
binary="$binary_dir/$(basename "$2")"
[ -x "$binary" ] || { printf '%s\n' 'Native OpenCode is not executable.' >&2; exit 1; }
for name in connection.json pac-source-token.txt pac-relay-ca.pem; do [ -r "$keys/$name" ] || { printf '%s\n' "Required private connection file is missing: $name" >&2; exit 1; }; done
repo=$(CDPATH= cd -P "$(dirname "$0")/.." && pwd -P)
cd "$repo"
revision=$(git rev-parse --verify HEAD)
case "$revision" in *[!0-9a-f]*|'') printf '%s\n' 'Invalid checkout revision.' >&2; exit 1;; esac
[ "${#revision}" -eq 40 ] || { printf '%s\n' 'Invalid checkout revision.' >&2; exit 1; }
umask 077
base="$HOME/.local/share/pac-bridge"
if [ -e "$base" ] && [ ! -f "$base/.pac-bridge-install" ]; then printf '%s\n' 'Existing installation directory is not managed by this installer.' >&2; exit 1; fi
mkdir -p "$base/versions" "$base/bin"
: > "$base/.pac-bridge-install"
if ! mkdir "$base/.install-lock" 2>/dev/null; then printf '%s\n' 'Another installation is in progress.' >&2; exit 1; fi
stage=''
cleanup() { case "$stage" in "$base"/versions/.stage.*) [ ! -d "$stage" ] || rm -rf "$stage";; esac; rmdir "$base/.install-lock" 2>/dev/null || :; }
trap cleanup EXIT HUP INT TERM
for name in connection-directory opencode-path; do
  if [ -f "$base/$name" ]; then
    case "$name" in connection-directory) expected=$keys;; opencode-path) expected=$binary;; esac
    [ "$(cat "$base/$name")" = "$expected" ] || { printf '%s\n' 'Existing installation uses a different connection or OpenCode path.' >&2; exit 1; }
  fi
done
target="$base/versions/$revision"
if [ ! -d "$target" ]; then
  stage=$(mktemp -d "$base/versions/.stage.XXXXXXXX")
  git archive HEAD adapters src source-package scripts/pac-posix-launcher.mjs | tar -xf - -C "$stage"
  cp "$stage/source-package/package.json" "$stage/package.json"
  cp "$stage/source-package/package-lock.json" "$stage/package-lock.json"
  (cd "$stage" && npm ci --omit=dev --no-audit --no-fund)
  : > "$stage/.complete"
  mv "$stage" "$target"
  stage=''
fi
[ -f "$target/.complete" ] && [ -f "$target/adapters/pac-hapi-opencode.mjs" ] && [ -f "$target/scripts/pac-posix-launcher.mjs" ] || { printf '%s\n' 'Existing staged version is incomplete.' >&2; exit 1; }
cp "$target/scripts/pac-posix-launcher.mjs" "$base/bin/pac-posix-launcher.mjs.tmp"
mv "$base/bin/pac-posix-launcher.mjs.tmp" "$base/bin/pac-posix-launcher.mjs"
cat > "$base/bin/opencode.tmp" <<'EOF'
#!/bin/sh
exec node "$(dirname "$0")/pac-posix-launcher.mjs" "$@"
EOF
chmod 700 "$base/bin/opencode.tmp"
mv "$base/bin/opencode.tmp" "$base/bin/opencode"
printf '%s\n' "$keys" > "$base/connection-directory.tmp"; mv "$base/connection-directory.tmp" "$base/connection-directory"
printf '%s\n' "$binary" > "$base/opencode-path.tmp"; mv "$base/opencode-path.tmp" "$base/opencode-path"
printf '%s\n' "$revision" > "$base/current.tmp"; mv "$base/current.tmp" "$base/current"
printf '%s\n' 'PAC Bridge launcher installed. Put ~/.local/share/pac-bridge/bin first in the existing HAPI runner PATH.'
printf '%s\n' 'Existing HAPI processes and chats were not restarted.'
