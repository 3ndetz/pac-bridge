# Linux and macOS development setup

Clone the repository and prepare its locked dependencies:

```sh
git clone https://github.com/3ndetz/pac-bridge.git
cd pac-bridge
sh scripts/prepare-posix.sh
```

The script requires Node.js 24 or later, npm and Git. It does not alter an existing HAPI profile. The relay, controller, and source adapters are in `adapters/`; their development setup, credential separation, TLS requirements, and launcher commands are documented in [OPENCODE-EXPERIMENT.md](../OPENCODE-EXPERIMENT.md).

There is currently no reviewed unattended installer for an existing Linux or macOS HAPI profile. The native primitive tests and the authenticated Windows deployment do not establish end-to-end support on those systems. Provisioning, startup, upgrades, and the full tool, hook and skill matrix on each platform remain acceptance work. Do not copy Claude authentication from the controller to a source machine.
