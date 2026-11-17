# Linux source-side setup candidate

This candidate is under review. Do not deploy it or use it to migrate an existing HAPI runner until the outstanding acceptance checks are complete.

Install Git, Node.js 24 or later, npm, Python 3 with `fcntl`, Bash, `readlink` and a compatible native OpenCode. Keep the existing HAPI hub and runner. Transfer the private connection directory separately: it must contain `connection.json`, `pac-source-token.txt` and `pac-relay-ca.pem`. Do not copy the Claude login from the controller.

Clone this repository to a permanent location and stage a versioned launcher:

```sh
git clone https://github.com/3ndetz/pac-bridge.git
cd pac-bridge
sh scripts/install-posix.sh "$HOME/Downloads/PAC-Bridge-keys" "$(command -v opencode)"
```

The installer uses the committed Git revision and the locked source-only dependencies. This candidate stores its version, launcher and session bindings under `~/.local/share/pac-bridge-v2`; connection files remain in their private directory. An existing `~/.local/share/pac-bridge` object causes an early refusal before the candidate profile is created. Existing candidate installations with a different connection directory or native OpenCode path are rejected for review. The installer does not start or restart HAPI, create a hub, or modify its source or profile.

The installer uses a persistent `.install-flock` file and kernel locks on that
file and its parent directory. It never deletes or changes an existing lock
file. The kernel releases the locks once the installer and any child processes
holding them have exited, so a retry can proceed after interruption. A legacy
`.install-lock` object is preserved and blocks installation: inspect the owning
installation and confirm no installer is running before arranging its reviewed
recovery. Never remove an unverified lock to force installation.

On Linux, publication writes an anonymous temporary inode and links it once at
the destination. Existing destination files must have the expected contents,
owner, private permissions and a single link; conflicting files and symlinks
stop the installer without replacement. Interrupted stages are retained rather
than automatically deleted. An interrupted first creation before the profile
marker is written also stops for review.

For installations created by this candidate, updates append a new immutable
generation and select its versioned launcher for subsequent launches; prior
generation files and the original `current` marker remain intact. A stable
bootstrap selects and pins one generation per launch. If that bootstrap itself
changes, the installer stops instead of overwriting it. An isolated test
installs the historical baseline and checks the candidate refuses to create
another profile while the old binding, synthetic session process and data
remain intact, including a run with real Git, Node and npm. This does not
prove real HAPI-session continuity or migrate existing bindings. Automatic
legacy upgrade and recovery remain unavailable pending a reviewed design.

The generation record pins a digest of staged `adapters`, `src`, `scripts`,
package manifest files, and `node_modules`. Installation and the bootstrap
check that digest; they refuse changes to those files or to the completion
marker. An independent writer can still race a check and subsequent execution.
The installed Node executable and system libraries are outside the digest. This is not a complete
same-account tamper-resistance guarantee.

This candidate currently refuses non-Linux platforms and filesystems without
the required anonymous temporary file support. It requires a private,
user-owned installation directory and filesystem support for the required
locking, no-follow flags and symlinks. It does not establish safety against
arbitrary same-account pathname replacement, nor power-loss durability.
The publication helper and Python stage inspection use directory descriptors,
but shell setup, staging commands, generation traversal and the JavaScript
runtime still have pathname race windows. A checked directory can also be
renamed after the final identity check. Do not treat these changes as complete
ancestor-race protection or deploy this candidate.
Synthetic tests ran on Linux in a container; macOS, network filesystems and a
complete installed HAPI workflow remain unverified. Do not infer portable
production safety from these tests.

Publication flushes the newly written file and its destination directory, and
also flushes directories after selected creation and version-link operations.
Other staged files, dependency files, ancestor directories and storage caches
have not been proven durable across a system crash or power failure. An
injected directory-flush error is handled by retaining the visible objects and
refusing the operation; a retry attempts the flush again. This is not a
substitute for power-loss testing.

Start the **existing** HAPI runner with `~/.local/share/pac-bridge-v2/bin` first in its `PATH`, preserving its existing profile, other environment and machine identity. For a service-managed runner, set this in the service's environment and apply it only at an appropriate time: a running process cannot inherit a changed `PATH`. Do not start a second hub or runner as a substitute. Then create an OpenCode chat on that existing machine and verify its PAC model, a real reply, tools, permissions, skills and hooks. If the PAC profile is unavailable or `NODE_EXTRA_CA_CERTS` points to a different file, the launcher reports the issue and starts native OpenCode without advertising PAC models; it does not override the user's CA configuration.

The source launcher can be staged and checked on Linux, but authenticated end-to-end HAPI installation, restart, update and rollback have not yet been verified on Linux or macOS. macOS execution is also unverified. These are acceptance items, not completed platform support. The development-only dependency setup is still available with `sh scripts/prepare-posix.sh`; see [OPENCODE-EXPERIMENT.md](../OPENCODE-EXPERIMENT.md) for runtime limitations.

Run `sh scripts/verify-posix-install.sh` to check a synthetic installation, repeated installation, command forwarding and conflict protection without starting HAPI or connecting to a PAC. It uses an isolated temporary home and downloads the locked npm dependencies.

For an explicitly authorized, paid real-PAC source check, set `PAC_TEST_LIVE=1` and run `node scripts/verify-posix-live.mjs` after installation. It creates a temporary project, invokes the selected PAC through the installed launcher, checks a skill, its resource and pre/post tool hooks, then removes its own project. It does not start a HAPI hub. Set `PAC_TEST_MODEL` if the PAC uses a different model ID. This check does not replace testing the existing HAPI runner.

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
