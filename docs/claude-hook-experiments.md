# Isolated Claude hook experiments

These helpers and synthetic tests exercise Claude-specific hooks and private transcript handling. They are not OpenCode plugin support or source-machine acceptance. The OpenCode adapter does not load local Claude settings, rules, hooks or skills. Earlier Claude hook results in ACCEPTANCE.md are historical experiment evidence, not proof of OpenCode feature parity.

## Private Windows Stop transcript groundwork

The synthetic lifecycle route (`PAC_TEST_SYNTHETIC_LIFECYCLE=1`) can now exercise Stop block/continue and resume on Windows as well as Linux. This flag is still required; global Stop hooks and installed-runtime compatibility are not enabled by these checks.

On Windows, snapshot reads require a local NTFS path, retained non-reparse directory handles, a single-link regular file of at most 1 MiB, and a read handle that excludes concurrent writes and deletion. The file owner must be the current user or the current token default owner; the latter is the [SID Windows applies to newly created objects](https://learn.microsoft.com/en-us/dotnet/api/system.security.principal.windowsidentity.owner?view=netframework-4.8.1). ACL grants may target only the current user, SYSTEM or Administrators. Other grants are rejected. An existing broadly inherited SDK profile is not silently repaired or accepted. Synthetic SDK tests provision a private disposable profile before creating history.

The source-side callback receives an ephemeral user-only transcript created atomically inside a protected directory. Its retained handles exclude file replacement and directory renaming. Delete-on-close removes the file on host termination, and loss of the parent owner pipe terminates the contained helper job. Normal completion also removes the empty directory. A hard crash can leave an empty directory or compiler scratch data; these require separately verified ownership before removal. The helper does not sandbox code running under the same Windows account.

Focused tests cover encoding/size bounds, default-token ownership, broad ACL rejection, hard links, junction ancestors, concurrent writer rejection, keeper write/rename rejection, callback failure, real source hook execution and parent loss. The parent-loss fixture confirms its enclosing Job has zero processes before removing its synthetic profile. The fake-model controller scenario covers Stop block/continue and resumed history without paid calls or real MCP/plugin discovery.
