# Installer entrypoint audit

This is an isolated, unpublished audit of the base revision. It is not a
release recommendation. A script's presence does not mean the corresponding
platform or installation path has passed acceptance.

| Path | Role | Findings requiring review |
| --- | --- | --- |
| `windows/Configure-ExistingProvider.ps1` | Initial provider configuration on an existing profile | Existing runtime mutation, failed-profile ownership, crash recovery and safe retry remain unresolved. The isolated candidate refuses before profile creation. |
| `windows/Install-ProviderMode.ps1` | Stage or activate a provider revision | Version staging and activation modify multiple objects. Pointer and loader writes are not independently race-safe or crash-recovered. The isolated candidate refuses at entry. |
| `windows/Disable-ProviderMode.ps1` | Disable provider loading | Reads and backs up the runtime before a forceful rename; it has a check-to-replacement race and no proven recovery transaction. |
| `windows/Enable-LiveProviderDispatch.ps1` | Migrate or restore a launcher | Backup, metadata and forceful replacement are separate operations. Checks do not exclude independent modification between verification and replacement. |
| `windows/Enable-TelegramNotify.ps1` | Configure notifications | Creates a private directory and files before replacing the launcher. Failure can retain a partial setup; the fixed temporary name and replacement need a race and crash audit. |
| `windows/Use-CodexTelegramNotify.ps1` | Select an existing sender | Creates or changes notification directory permissions before writing a pointer. Ownership, reparse races and partial failure require review. |
| `windows/Install-FromRepo.ps1` | Legacy downloader | Downloads a custom HAPI binary before calling the legacy installer. Disabled in this candidate. |
| `windows/Install-PacRunner.ps1` | Legacy fresh-profile installation | Installs a custom HAPI runtime and writes multiple profile objects. Disabled in this candidate. |
| `windows/Install-ExistingProfile.ps1` | Legacy existing-profile installation | Installs a custom HAPI runtime and pin and writes multiple profile objects. Disabled in this candidate. |
| `scripts/install-posix.sh` | Experimental Linux/macOS source launcher | Creates a marker and lock, stages a version, and replaces several independently named files. Abrupt termination can retain a lock or a mixture of versions; fixed temporary names, symlinks, marker ownership and no-clobber guarantees need adversarial testing. Full platform/HAPI acceptance is open. |
| `scripts/prepare-posix.sh` | Development dependencies | Runs npm in the checkout; this is not an installer or a production recovery procedure. |
| `adapters/install-hapi-command.mjs` | Generate a new wrapper | Requests a new directory and exclusive creation of its file. A crash after directory creation can leave a partial directory; parent identity and symlink protections are not proven. |
| `client-up.sh` | Superseded container/shared-filesystem prototype | Copies a plugin over its target and stops a matching container process. The root README excludes this older design from the current installation guide; it is not a supported fallback. |

`docs/windows-setup.md` identifies the legacy binary route as superseded, but
the base revision's `windows/README.md` still describes and recommends it.
The coordinating session reported adding a historical warning in the shared
checkout; that change is outside this isolated worktree. Remaining documentation
and the actual entrypoints still require review before release.

The same recovery requirements apply to installation, update, migration,
notification setup and disable/restore: never overwrite independently changed
objects; establish object and parent ownership without following reparse points
or symlinks; make incomplete state recognizable; and prove safe retries and
startup behavior at each interruption point. POSIX and Windows require separate
filesystem-specific evidence. Process termination tests alone do not establish
power-loss durability.

An isolated Git Bash test on Windows terminated the POSIX script after lock
creation and reproduced a retained lock that rejects the next run. This is a
reproduction of the gap, not evidence for Linux or macOS behavior or a safe
automatic stale-lock recovery algorithm.

Another isolated Git Bash test created a hard link from the fixed `current.tmp`
name to an unrelated synthetic file. The installer overwrote that file while
updating the pointer. This is a demonstrated no-clobber failure in the tested
environment; Linux/macOS execution and symlink variants remain unverified.

An isolated Windows test paused provider disable before the final move, changed
the synthetic runtime independently, and observed the disable command replacing
that change. A separate test reproduced the same class of overwrite during
live-dispatch migration after its pre-replacement check. These confirm the
check-to-replacement races in those entrypoints.
An additional Windows fixture reproduced overwriting an unrelated file through
a hard link at the fixed notification-wrapper temporary name.
Another fixture showed the Codex notification setup following a `notify`
junction and creating its pointer outside the synthetic PAC profile.
An interrupted wrapper-generator fixture retained the newly created directory;
the next invocation failed with `EEXIST` before it could complete the wrapper.
For the base provider activation script, a fixture also reproduced overwriting
an existing loader and an unrelated file linked to its fixed pointer temporary
name.
