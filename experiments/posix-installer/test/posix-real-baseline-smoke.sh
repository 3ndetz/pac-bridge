#!/bin/sh
set -eu
mkdir -p /tmp/pac-baseline-repo /tmp/pac-candidate-repo /tmp/pac-baseline-home /tmp/pac-baseline-keys /tmp/pac-baseline-native
git --git-dir=/baseline-git archive 1977ab8f48a555c40bea27817130cccd64645b8e | tar -x -C /tmp/pac-baseline-repo
printf '%s\n' '{"relayUrl":"wss://example.invalid","pacName":"test","controllerCwd":"/synthetic"}' > /tmp/pac-baseline-keys/connection.json
printf '%s\n' synthetic > /tmp/pac-baseline-keys/pac-source-token.txt
printf '%s\n' synthetic > /tmp/pac-baseline-keys/pac-relay-ca.pem
printf '%s\n' '#!/bin/sh' 'printf "native-proof\n"' > /tmp/pac-baseline-native/opencode
chmod 700 /tmp/pac-baseline-native/opencode
export HOME=/tmp/pac-baseline-home
cd /tmp/pac-baseline-repo
git init -q
git add .
git -c user.name=Test -c user.email=test@example.invalid commit -qm baseline
sh scripts/install-posix.sh /tmp/pac-baseline-keys /tmp/pac-baseline-native/opencode
old="$HOME/.local/share/pac-bridge"
new="$HOME/.local/share/pac-bridge-v2"
mkdir -p "$HOME/.hapi-synthetic"
printf '%s\n' 'existing synthetic session' > "$HOME/.hapi-synthetic/session"
mkdir -p "$old/bindings"
printf '%s\n' 'synthetic binding' > "$old/bindings/session.json"
sleep 300 &
session_pid=$!
trap 'kill "$session_pid" 2>/dev/null || true' EXIT HUP INT TERM
sha256sum "$old/bin/opencode" "$old/bin/pac-posix-launcher.mjs" "$old/current" "$old/bindings/session.json" "$HOME/.hapi-synthetic/session" > /tmp/pac-baseline-before
tar -cf - -C "$old" . | sha256sum > /tmp/pac-baseline-tree-before
PATH="$old/bin:$PATH" opencode --version > /tmp/pac-before-output
[ "$(cat /tmp/pac-before-output)" = native-proof ]
cp -a /repo/scripts /repo/adapters /repo/src /repo/source-package /tmp/pac-candidate-repo/
cp /repo/.gitattributes /tmp/pac-candidate-repo/
cd /tmp/pac-candidate-repo
git init -q
git add .
git -c user.name=Test -c user.email=test@example.invalid commit -qm candidate
if sh scripts/install-posix.sh /tmp/pac-baseline-keys /tmp/pac-baseline-native/opencode; then exit 1; fi
[ ! -e "$new" ] && [ ! -L "$new" ]
sha256sum -c /tmp/pac-baseline-before
tar -cf - -C "$old" . | sha256sum > /tmp/pac-baseline-tree-after
cmp /tmp/pac-baseline-tree-before /tmp/pac-baseline-tree-after
kill -0 "$session_pid"
[ "$(PATH="$old/bin:$PATH" command -v opencode)" = "$old/bin/opencode" ]
[ "$(PATH="$old/bin:$PATH" opencode --version)" = native-proof ]
sha256sum -c /tmp/pac-baseline-before
kill -0 "$session_pid"
printf '%s\n' 'Synthetic baseline refusal preserved the existing profile, binding and process; actual HAPI session was not tested.'
