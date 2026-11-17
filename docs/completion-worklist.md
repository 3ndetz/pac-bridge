# Remaining completion work

The owner deferred macOS acceptance on 2026-11-17 because no Mac is available. Current delivery scope is Windows and Linux; macOS remains future work, not a current blocker.

This list preserves the ongoing assignment. Detailed requirements and earlier evidence remain in [the reliability checklist](../RELIABILITY-CHECKLIST.md) and [acceptance](../ACCEPTANCE.md). A local regression does not close installed-runtime acceptance.

1. Process lifecycle and recovery: fix provider shutdown and concurrent compaction (31 synthetic Windows checks passed); stalled uploads, pending permissions, router shutdown races and initialize cancellation also passed focused checks; controller child ownership, generation drain and awaitable shutdown also passed synthetic and real-contained-child regressions. Linux now has a subreaper/pidfd owner with private drain acknowledgement and tested parent-control loss. Remaining: installed serve shutdown, Windows parent-loss ownership, archive latency and live recovery of uncertain actions.
2. Session authorization: define and enforce the client/session trust boundary before enabling experimental shared-provider controls.
3. Source compatibility: complete global settings, proxy handling, hooks, private Windows transcripts, skill resources and precedence; keep unsupported policies explicit.
4. OpenCode request routing: distinguish auxiliary requests from real turns with tools disabled without duplicate execution.
5. Installation: POSIX selected-commit identity, early checkout validation and owned signal regressions passed; finish Windows/POSIX update, crash recovery, retry, rollback and no-clobber behavior; preserve existing identity and sessions. The drafts under experiments remain unsupported. macOS verification is deferred by the owner.
6. Deployment: migrate remaining PAC-specific HAPI changes through supported integration, verify relay recovery and staged provider revisions without interrupting active chats.
7. Live acceptance: existing hubs on both Windows machines, model catalogue, tools, permissions, hooks, compaction, context recall, resume, concurrent sessions and background task controls. Verify the intended Linux workflow separately; macOS is deferred.
8. Release reconciliation: ownership-verified old staging cleanup, privacy review, necessary private connection kit and update instructions, existing Jira evidence following the shared reporting route, all verified changes committed and pushed to main.

Trusted source MCP/plugin provenance discovery remains unavailable. Do not enable that route or infer configuration acceptance from synthetic transport checks.
