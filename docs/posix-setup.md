# Linux and macOS source-side setup

Install Git, Node.js 24 or later, npm, Bash and a compatible native OpenCode. Keep the existing HAPI hub and runner. Transfer the private connection directory separately: it must contain `connection.json`, `pac-source-token.txt` and `pac-relay-ca.pem`. Do not copy the Claude login from the controller.

Clone this repository to a permanent location and stage a versioned launcher:

```sh
git clone https://github.com/3ndetz/pac-bridge.git
cd pac-bridge
sh scripts/install-posix.sh "$HOME/Downloads/PAC-Bridge-keys" "$(command -v opencode)"
```

The installer uses the committed Git revision and the locked source-only dependencies. It stores the version, launcher and session bindings under `~/.local/share/pac-bridge`; connection files remain in their private directory. Existing installations with a different connection directory or native OpenCode path are rejected for review. The installer does not start or restart HAPI, create a hub, or modify its source or profile.

Start the **existing** HAPI runner with `~/.local/share/pac-bridge/bin` first in its `PATH`, preserving its existing profile, other environment and machine identity. For a service-managed runner, set this in the service's environment and apply it only at an appropriate time: a running process cannot inherit a changed `PATH`. Do not start a second hub or runner as a substitute. Then create an OpenCode chat on that existing machine and verify its PAC model, a real reply, tools, permissions, skills and hooks. If `NODE_EXTRA_CA_CERTS` is already set to a different file, the launcher stops for review rather than overriding the user's CA configuration.

The source launcher can be staged and checked on Linux, but authenticated end-to-end HAPI installation, restart, update and rollback have not yet been verified on Linux or macOS. macOS execution is also unverified. These are acceptance items, not completed platform support. The development-only dependency setup is still available with `sh scripts/prepare-posix.sh`; see [OPENCODE-EXPERIMENT.md](../OPENCODE-EXPERIMENT.md) for runtime limitations.

Run `sh scripts/verify-posix-install.sh` to check a synthetic installation, repeated installation, command forwarding and conflict protection without starting HAPI or connecting to a PAC. It uses an isolated temporary home and downloads the locked npm dependencies.

## Prompt for an agent on another computer

```text
Configure PAC Bridge from https://github.com/3ndetz/pac-bridge using
docs/posix-setup.md for this account's existing HAPI runner and hub. Preserve
its machine identity, profile and sessions; do not create another hub or
runner. The private connection directory is supplied separately. Never print
or commit its contents. Install the source launcher and dependencies from Git,
then verify PAC model discovery, an actual reply, tools, permissions, skills,
hooks, compaction and recovery. Report each result and every remaining gap.
```
