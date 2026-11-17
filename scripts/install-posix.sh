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
checkout=$(git rev-parse --show-toplevel 2>/dev/null) || { printf '%s\n' 'The source must be a Git checkout.' >&2; exit 1; }
checkout=$(CDPATH= cd -P "$checkout" && pwd -P)
[ "$checkout" = "$repo" ] || { printf '%s\n' 'The source must be the root of its own Git checkout.' >&2; exit 1; }
revision=$(git rev-parse --verify HEAD)
case "$revision" in *[!0-9a-f]*|'') printf '%s\n' 'Invalid checkout revision.' >&2; exit 1;; esac
[ "${#revision}" -eq 40 ] || { printf '%s\n' 'Invalid checkout revision.' >&2; exit 1; }
git diff --quiet "$revision" -- adapters src source-package scripts/install-posix.sh scripts/pac-posix-launcher.mjs || { printf '%s\n' 'Commit or discard source changes before installing.' >&2; exit 1; }
for file in adapters/pac-hapi-opencode.mjs src/opencode-provider.mjs source-package/package.json source-package/package-lock.json scripts/pac-posix-launcher.mjs; do
  git cat-file -e "$revision:$file" 2>/dev/null || { printf '%s\n' 'The selected commit is missing required tracked provider files.' >&2; exit 1; }
done
umask 077
base="$HOME/.local/share/pac-bridge"
if [ -e "$base" ] && [ ! -f "$base/.pac-bridge-install" ]; then printf '%s\n' 'Existing installation directory is not managed by this installer.' >&2; exit 1; fi
mkdir -p "$base/versions" "$base/bin"
if [ ! -f "$base/.pac-bridge-install" ]; then
  (set -C; : > "$base/.pac-bridge-install") 2>/dev/null || { printf '%s\n' 'Could not safely create installation marker.' >&2; exit 1; }
fi
if ! mkdir "$base/.install-lock" 2>/dev/null; then printf '%s\n' 'Installation lock exists; inspect its owner and state before retrying.' >&2; exit 1; fi
stage=''
temp=''
cleanup() {
  cleanup_uncertain=0
  case "$stage" in
    "$base"/versions/.stage.*)
      if [ -L "$stage" ]; then
        cleanup_uncertain=1
      elif [ -d "$stage" ]; then
        resolved_base=$(CDPATH= cd -P "$base" && pwd -P) || resolved_base=''
        resolved_versions=$(CDPATH= cd -P "$base/versions" && pwd -P) || resolved_versions=''
        resolved_stage=$(CDPATH= cd -P "$stage" && pwd -P) || resolved_stage=''
        if [ -n "$resolved_base" ] && [ "$resolved_versions" = "$resolved_base/versions" ] &&
           [ "$resolved_stage" = "$resolved_versions/${stage##*/}" ]; then
          case "${resolved_stage##*/}" in .stage.*) rm -rf "$resolved_stage" || cleanup_uncertain=1; [ ! -e "$resolved_stage" ] || cleanup_uncertain=1;; *) cleanup_uncertain=1;; esac
        else
          cleanup_uncertain=1
        fi
      else
        cleanup_uncertain=1
      fi;;
    '') ;;
    *) cleanup_uncertain=1;;
  esac
  if [ -n "$temp" ] && { [ -e "$temp" ] || [ -L "$temp" ]; }; then
    resolved_base=$(CDPATH= cd -P "$base" && pwd -P) || resolved_base=''
    resolved_parent=$(CDPATH= cd -P "$(dirname "$temp")" && pwd -P) || resolved_parent=''
    case "$temp" in
      "$base"/.install.*) expected_parent=$resolved_base;;
      "$base"/bin/.install.*) expected_parent=$resolved_base/bin;;
      *) expected_parent='';;
    esac
    if [ -z "$resolved_base" ] || [ -z "$expected_parent" ] || [ "$resolved_parent" != "$expected_parent" ] || [ -L "$temp" ]; then
      cleanup_uncertain=1
    else
      rm -f "$temp" || cleanup_uncertain=1
      if [ -e "$temp" ] || [ -L "$temp" ]; then cleanup_uncertain=1; fi
    fi
  fi
  if [ "$cleanup_uncertain" -ne 0 ]; then
    printf '%s\n' 'Installer cleanup is unconfirmed; lock retained for inspection.' >&2
    exit 1
  fi
  rmdir "$base/.install-lock" 2>/dev/null || { printf '%s\n' 'Installer lock removal is unconfirmed.' >&2; exit 1; }
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
for name in connection-directory opencode-path; do
  if [ -f "$base/$name" ]; then
    case "$name" in connection-directory) expected=$keys;; opencode-path) expected=$binary;; esac
    [ "$(cat "$base/$name")" = "$expected" ] || { printf '%s\n' 'Existing installation uses a different connection or OpenCode path.' >&2; exit 1; }
  fi
done
target="$base/versions/$revision"
if [ ! -d "$target" ]; then
  stage=$(mktemp -d "$base/versions/.stage.XXXXXXXX")
  git archive "$revision" adapters src source-package scripts/pac-posix-launcher.mjs | tar -xf - -C "$stage"
  cp "$stage/source-package/package.json" "$stage/package.json"
  cp "$stage/source-package/package-lock.json" "$stage/package-lock.json"
  (cd "$stage" && npm ci --omit=dev --no-audit --no-fund)
  : > "$stage/.complete"
  mv "$stage" "$target"
  stage=''
fi
[ -f "$target/.complete" ] && [ -f "$target/adapters/pac-hapi-opencode.mjs" ] && [ -f "$target/scripts/pac-posix-launcher.mjs" ] || { printf '%s\n' 'Existing staged version is incomplete.' >&2; exit 1; }
temp=$(mktemp "$base/bin/.install.XXXXXXXX")
cp "$target/scripts/pac-posix-launcher.mjs" "$temp"
mv -f "$temp" "$base/bin/pac-posix-launcher.mjs"
temp=$(mktemp "$base/bin/.install.XXXXXXXX")
cat > "$temp" <<'EOF'
#!/bin/sh
exec node "$(dirname "$0")/pac-posix-launcher.mjs" "$@"
EOF
chmod 700 "$temp"
mv -f "$temp" "$base/bin/opencode"
write_value() {
  temp=$(mktemp "$base/.install.XXXXXXXX")
  printf '%s\n' "$2" > "$temp"
  mv -f "$temp" "$base/$1"
}
write_value connection-directory "$keys"
write_value opencode-path "$binary"
write_value current "$revision"
temp=''
printf '%s\n' 'PAC Bridge launcher installed. Put ~/.local/share/pac-bridge/bin first in the existing HAPI runner PATH.'
printf '%s\n' 'Existing HAPI processes and chats were not restarted.'
