#!/bin/sh
set -eu
repo=$(CDPATH= cd -P "$(dirname "$0")/.." && pwd -P)
root=$(mktemp -d "${TMPDIR:-/tmp}/pac-installer-file-safety.XXXXXXXX")
cleanup() {
  parent=$(CDPATH= cd -P "${TMPDIR:-/tmp}" && pwd -P)
  actual=$(CDPATH= cd -P "$root" && pwd -P)
  [ "$(dirname "$actual")" = "$parent" ] || { printf '%s\n' 'Refusing unexpected cleanup parent.' >&2; exit 1; }
  case "${actual##*/}" in pac-installer-file-safety.*) rm -rf "$actual";; *) printf '%s\n' 'Refusing unexpected cleanup path.' >&2; exit 1;; esac
}
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
mkdir -p "$root/failing-home"
printf '%s\n' '#!/bin/sh' 'exit 1' > "$root/bin/npm"
chmod 700 "$root/bin/npm"
if HOME="$root/failing-home" sh "$repo/scripts/install-posix.sh" "$root/keys" "$root/native/opencode" >/dev/null 2>&1; then
  printf '%s\n' 'A failed dependency installation was accepted.' >&2; exit 1
fi
[ ! -e "$root/failing-home/.local/share/pac-bridge/.install-lock" ] || { printf '%s\n' 'Lock was not released after failure.' >&2; exit 1; }
[ -z "$(find "$root/failing-home/.local/share/pac-bridge/versions" -mindepth 1 -maxdepth 1 -print -quit)" ] || { printf '%s\n' 'Failed stage was not removed.' >&2; exit 1; }
real_rm=$(command -v rm)
export PAC_TEST_REAL_RM="$real_rm"
cat > "$root/bin/rm" <<'EOF'
#!/bin/sh
case "$*" in *'/.stage.'*|*'/.install.'*) exit 1;; esac
exec "$PAC_TEST_REAL_RM" "$@"
EOF
chmod 700 "$root/bin/rm"
mkdir -p "$root/uncertain-home"
if HOME="$root/uncertain-home" sh "$repo/scripts/install-posix.sh" "$root/keys" "$root/native/opencode" >/dev/null 2>&1; then
  printf '%s\n' 'An unconfirmed stage cleanup was accepted.' >&2; exit 1
fi
[ -d "$root/uncertain-home/.local/share/pac-bridge/.install-lock" ] || { printf '%s\n' 'Lock was removed despite unconfirmed cleanup.' >&2; exit 1; }
[ -n "$(find "$root/uncertain-home/.local/share/pac-bridge/versions" -mindepth 1 -maxdepth 1 -print -quit)" ] || { printf '%s\n' 'The uncertain stage was not preserved.' >&2; exit 1; }
real_mv=$(command -v mv)
export PAC_TEST_REAL_MV="$real_mv"
cat > "$root/bin/mv" <<'EOF'
#!/bin/sh
case "$*" in *'/bin/.install.'*) exit 1;; esac
exec "$PAC_TEST_REAL_MV" "$@"
EOF
chmod 700 "$root/bin/mv"
printf '%s\n' '#!/bin/sh' 'exit 0' > "$root/bin/npm"
chmod 700 "$root/bin/npm"
mkdir -p "$root/uncertain-temp-home"
if HOME="$root/uncertain-temp-home" sh "$repo/scripts/install-posix.sh" "$root/keys" "$root/native/opencode" >/dev/null 2>&1; then
  printf '%s\n' 'An unconfirmed temporary-file cleanup was accepted.' >&2; exit 1
fi
[ -d "$root/uncertain-temp-home/.local/share/pac-bridge/.install-lock" ] || { printf '%s\n' 'Lock was removed despite unconfirmed temporary-file cleanup.' >&2; exit 1; }
[ -n "$(find "$root/uncertain-temp-home/.local/share/pac-bridge/bin" -name '.install.*' -print -quit)" ] || { printf '%s\n' 'The uncertain temporary file was not preserved.' >&2; exit 1; }
printf '%s\n' 'Installer preserved pre-existing hard-linked files.'
