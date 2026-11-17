# Workspace reconciliation

Portable task regressions are retained in the scoped Node test suite. Native SDK experiments remain explicit opt-ins; their prerequisites and verification limits are documented in [runtime probes](runtime-probes.md).

One-off diagnostic scripts bound to temporary snapshots, external machine harnesses and installed profiles are retired from the public working tree after exact local recovery copies are verified. Private recovery material and its inventory are not public release artifacts. No historical authentication or deployment claim follows from preserving those files.

The unfinished launcher candidate supplied no verified owner identity to its parent watcher. It is excluded from the active launcher. Source MCP configuration provenance discovery remains unavailable. Removing unsupported experiments does not implement those capabilities; [acceptance requirements](experimental-mcp-validation.md) remain explicit.

Release verification must exercise the committed source snapshot. A clean Git status demonstrates that work is saved and reconciled; it does not establish completion of live-runtime, installation or platform acceptance checks.

Earlier installer-worktree source is preserved under the [Windows audit candidate](../experiments/windows-installer/README.md) and [POSIX recovery candidate](../experiments/posix-installer/README.md). The original drafts were compared with their private recovery copies before saving. These directories document unfinished designs and are excluded from the scoped release regression glob; they do not replace active product installation entrypoints.
