#!/bin/sh
set -eu

base=$1
repo=$2
revision=$3
keys=$4
binary=$5
safety="$repo/scripts/posix-install-safety.py"

for name in versions bin; do
  if [ -e "$base/$name" ] || [ -L "$base/$name" ]; then
    [ -d "$base/$name" ] && [ ! -L "$base/$name" ] || { printf '%s\n' 'Installation subdirectory requires review.' >&2; exit 1; }
  else
    mkdir "$base/$name" || { printf '%s\n' 'Installation subdirectory appeared concurrently.' >&2; exit 1; }
  fi
done

for name in connection-directory opencode-path; do
  if [ -e "$base/$name" ] || [ -L "$base/$name" ]; then
    [ -f "$base/$name" ] && [ ! -L "$base/$name" ] || { printf '%s\n' 'Existing installation file requires review.' >&2; exit 1; }
    case "$name" in connection-directory) expected=$keys;; opencode-path) expected=$binary;; esac
    [ "$(cat "$base/$name")" = "$expected" ] || { printf '%s\n' 'Existing installation differs; preserve it for review.' >&2; exit 1; }
  fi
done
python3 "$safety" sync-dir "$base"
python3 "$safety" compare-if-exists "$base/bin/pac-posix-launcher.mjs" < "$repo/scripts/pac-posix-bootstrap.mjs"
python3 "$safety" check-generation "$base" "$revision"

target="$base/versions/$revision"
if [ ! -e "$target" ] && [ ! -L "$target" ]; then
  stage=$(mktemp -d "$base/versions/.stage.XXXXXXXX")
  python3 "$safety" sync-dir "$base/versions"
  git archive HEAD adapters src source-package scripts/pac-posix-launcher.mjs scripts/pac-posix-bootstrap.mjs | tar --no-same-owner --no-same-permissions -xf - -C "$stage"
  cp "$stage/source-package/package.json" "$stage/package.json"
  cp "$stage/source-package/package-lock.json" "$stage/package-lock.json"
  (cd "$stage" && npm ci --omit=dev --no-audit --no-fund --no-bin-links)
  [ -f "$stage/adapters/pac-hapi-opencode.mjs" ] && [ -f "$stage/scripts/pac-posix-launcher.mjs" ] && [ -f "$stage/scripts/pac-posix-bootstrap.mjs" ] || { printf '%s\n' 'Staged version is incomplete.' >&2; exit 1; }
  python3 "$safety" seal-stage "$stage" > /dev/null
  python3 "$safety" version "$stage" "$target"
fi
[ -L "$target" ] || { printf '%s\n' 'Existing provider revision requires review.' >&2; exit 1; }
stage_name=$(readlink "$target")
case "$stage_name" in .stage.[A-Za-z0-9]*) ;; *) printf '%s\n' 'Provider revision target requires review.' >&2; exit 1;; esac
case "$stage_name" in */*|*..*) printf '%s\n' 'Provider revision target requires review.' >&2; exit 1;; esac
[ -d "$base/versions/$stage_name" ] && [ ! -L "$base/versions/$stage_name" ] && [ -f "$target/.complete" ] && [ ! -L "$target/.complete" ] && [ -f "$target/adapters/pac-hapi-opencode.mjs" ] && [ -f "$target/scripts/pac-posix-launcher.mjs" ] && [ -f "$target/scripts/pac-posix-bootstrap.mjs" ] || { printf '%s\n' 'Existing staged version is incomplete.' >&2; exit 1; }
digest=$(python3 "$safety" verify-stage "$base/versions/$stage_name")
python3 "$safety" sync-dir "$base/versions"

python3 "$safety" publish "$base/bin/pac-posix-launcher.mjs" < "$target/scripts/pac-posix-bootstrap.mjs"
cat <<'EOF' | python3 "$safety" publish "$base/bin/opencode" --executable
#!/bin/sh
exec node "$(dirname "$0")/pac-posix-launcher.mjs" "$@"
EOF
printf '%s\n' "$keys" | python3 "$safety" publish "$base/connection-directory"
printf '%s\n' "$binary" | python3 "$safety" publish "$base/opencode-path"
python3 "$safety" generation "$base" "$revision" "$digest"
printf '%s\n' 'PAC Bridge launcher installed. Put ~/.local/share/pac-bridge-v2/bin first in the existing HAPI runner PATH.'
printf '%s\n' 'Existing HAPI processes and chats were not restarted.'
