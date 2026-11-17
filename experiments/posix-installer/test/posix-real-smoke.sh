#!/bin/sh
set -eu
mkdir /tmp/pac-real-proof
cp -a /repo/scripts /repo/adapters /repo/src /repo/source-package /tmp/pac-real-proof/
cp /repo/.gitattributes /tmp/pac-real-proof/
cd /tmp/pac-real-proof
printf '%s\n' 'import WebSocket from "ws"; if (typeof WebSocket !== "function") throw new Error("missing runtime dependency"); process.stdout.write("first-generation\n")' > adapters/pac-hapi-opencode.mjs
git init -q
git add .
git -c user.name=Test -c user.email=test@example.invalid commit -qm synthetic
mkdir -p /tmp/pac-real-home /tmp/pac-real-keys /tmp/pac-real-bin
printf '%s\n' '{"relayUrl":"wss://example.invalid","pacName":"test","controllerCwd":"/synthetic"}' > /tmp/pac-real-keys/connection.json
printf '%s\n' synthetic > /tmp/pac-real-keys/pac-source-token.txt
printf '%s\n' synthetic > /tmp/pac-real-keys/pac-relay-ca.pem
printf '%s\n' '#!/bin/sh' 'printf "native-proof\n"' > /tmp/pac-real-bin/opencode
chmod 700 /tmp/pac-real-bin/opencode
export HOME=/tmp/pac-real-home
sh scripts/install-posix.sh /tmp/pac-real-keys /tmp/pac-real-bin/opencode
sh scripts/install-posix.sh /tmp/pac-real-keys /tmp/pac-real-bin/opencode
if ! "$HOME/.local/share/pac-bridge-v2/bin/opencode" --version > /tmp/pac-native-result; then
  find "$HOME/.local/share/pac-bridge-v2/versions" -type f -name pac-posix-launcher.mjs -exec stat -c 'type=%F uid=%u mode=%a links=%h' {} \;
  exit 1
fi
[ "$(cat /tmp/pac-native-result)" = native-proof ]
[ "$("$HOME/.local/share/pac-bridge-v2/bin/opencode" acp)" = first-generation ]
dependency="$HOME/.local/share/pac-bridge-v2/versions/$(git rev-parse HEAD)/node_modules/ws/index.js"
cp "$dependency" /tmp/pac-dependency-before
printf '%s\n' 'independent dependency change' > "$dependency"
if "$HOME/.local/share/pac-bridge-v2/bin/opencode" acp > /dev/null 2>&1; then exit 1; fi
if sh scripts/install-posix.sh /tmp/pac-real-keys /tmp/pac-real-bin/opencode > /dev/null 2>&1; then exit 1; fi
[ "$(cat "$dependency")" = 'independent dependency change' ]
cp /tmp/pac-dependency-before "$dependency"
[ "$("$HOME/.local/share/pac-bridge-v2/bin/opencode" acp)" = first-generation ]
first=$(git rev-parse HEAD)
cp "$HOME/.local/share/pac-bridge-v2/bin/pac-posix-launcher.mjs" /tmp/pac-bootstrap-before
printf '%s\n' 'process.stdout.write("second-generation\n")' > adapters/pac-hapi-opencode.mjs
printf '\n' >> scripts/pac-posix-launcher.mjs
git add adapters/pac-hapi-opencode.mjs scripts/pac-posix-launcher.mjs
git -c user.name=Test -c user.email=test@example.invalid commit -qm synthetic-upgrade
second=$(git rev-parse HEAD)
sh scripts/install-posix.sh /tmp/pac-real-keys /tmp/pac-real-bin/opencode
[ "$(cat "$HOME/.local/share/pac-bridge-v2/current")" = "$first" ]
[ "$(cut -d ' ' -f 1 "$HOME/.local/share/pac-bridge-v2/generations/0000000000000002")" = "$second" ]
cmp /tmp/pac-bootstrap-before "$HOME/.local/share/pac-bridge-v2/bin/pac-posix-launcher.mjs"
[ "$("$HOME/.local/share/pac-bridge-v2/bin/opencode" acp)" = second-generation ]
adapter="$HOME/.local/share/pac-bridge-v2/versions/$second/adapters/pac-hapi-opencode.mjs"
cp "$adapter" /tmp/pac-adapter-before
printf '%s\n' 'independent change' > "$adapter"
if "$HOME/.local/share/pac-bridge-v2/bin/opencode" acp > /dev/null 2>&1; then exit 1; fi
[ "$(cat "$adapter")" = 'independent change' ]
cp /tmp/pac-adapter-before "$adapter"
ln "$HOME/.local/share/pac-bridge-v2/generations/0000000000000002" /tmp/pac-independent-alias
if "$HOME/.local/share/pac-bridge-v2/bin/opencode" --version > /dev/null 2>&1; then exit 1; fi
[ -f /tmp/pac-independent-alias ]
printf '%s\n' 'Real Git, Node and npm candidate install, retry and generation selection passed; legacy migration is not covered.'
