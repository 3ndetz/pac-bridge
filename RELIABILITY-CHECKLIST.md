# PAC Bridge reliability and acceptance checklist

This checklist tracks outstanding work for the OpenCode-first integration. A checked item requires a reproducible test against the deployed configuration and evidence linked from `ACCEPTANCE.md`. Unit tests alone do not prove an end-to-end scenario. Do not describe untested scenarios as complete.

## Required workflow

- [ ] Use the existing HAPI hub and select an existing registered source machine; do not create a separate hub to substitute for this workflow.
- [ ] Create an OpenCode chat and select every available model from the intended PAC, with the named PAC and actual selected model matching throughout the turn.
- [ ] Exercise real Claude responses, streaming, reading, writing, editing, shell, search, permissions, cancellation, follow-up, and model switching on the selected source machine.
- [ ] Verify the same flow on the other Windows machine through its own existing HAPI hub and runner, including restart and reconnect. A temporary runner attached to the first machine's hub does not satisfy this criterion.
- [ ] Detect expired controller authentication and show actionable guidance without logging credentials or replaying an uncertain turn.

## Context, recovery and durability

- [x] Verify manual compaction actually compacts the PAC conversation and retains a deliberately recorded fact in the next turn on the installed working runner. The existing 1C-Prog runner and an isolated HAPI runner both passed with real Claude.
- [ ] Verify automatic compaction near the real context limit, including subsequent tools, instructions, skills, subagents, and session resume. Record model and limits used.
- [x] Exercise automatic compaction and context recall through HAPI with an artificially lowered test threshold; verify the completion notice is visible. This does not establish the production model's actual threshold.
- [ ] Verify session bindings, history, selected PAC and model survive runner, controller, relay, and Windows restarts without switching sessions or duplicating uncertain actions.
- [ ] Verify disconnection, reconnection, authorization expiry, model unavailability, concurrency, timeouts, and cancellation while actions are running. Confirm failures are explicit and recoverable.
- [ ] With the PAC relay unavailable, verify native OpenCode model discovery still works and the unavailable PAC is not advertised. This passed with the actual OpenCode ACP and an isolated synthetic native provider. The fix is staged for the next runner start on both Windows profiles; it is not yet verified in the running profiles.
- [ ] Store durable bindings and installation outside temporary build and checkout paths; preserve existing session bindings during migration.
- [x] Keep the verified PAC runner selected through a same-version managed kit repair, and reject a damaged pin or an incompatible base version. This was checked on the existing 1C-Prog profile and in isolated installer tests.

## Instructions, skills and hooks

- [ ] Inventory the actual installed OpenCode version's project and global instructions, skill search paths, metadata, plugin and hook events, tool permissions, and precedence.
- [ ] Implement and test each supported capability end to end on the source machine, including skill resources and before/after tool hooks. Explicitly reject or clearly warn about unsupported security-relevant configurations rather than silently skipping them.
- [ ] Verify project instructions, scoped rules, hooks and skills before and after compaction and resume, for main agents and subagents, with allow, deny, and failure cases.
- [ ] Document exactly which OpenCode and Claude capabilities are supported, unsupported, or not yet verified; do not claim complete parity without evidence.

## Installation and operation

- [ ] Replace the modified HAPI runner, hub and UI with integration using unmodified, normally updateable HAPI. Keep integration behavior in PAC Bridge or supported extension interfaces; do not patch HAPI source or distribute a custom HAPI binary.
- [ ] Verify model discovery, streamed answers, tools, permissions, questions, context compaction, session recovery, background tasks and Telegram notifications end to end with the unmodified HAPI. Record unsupported behavior instead of claiming parity.
- [ ] Test HAPI and OpenCode version updates and rollback with existing sessions and machine identity preserved. Keep the existing deployment until this migration is verified.
- [ ] Provide versioned, reproducible installation from the repository using scripts and existing runtimes. Avoid a custom standalone executable or PAC Bridge archive; verify dependencies and explain any unavoidable platform runtime.
- [ ] Ensure background startup and subprocesses run without visible console windows. Verify restart and operation under the existing user profile; do not require a new hub or service account.
- [ ] Integrate with each machine's existing hub and runner without creating another hub, overwriting an unrelated configuration, or copying machine identity; verify the target profile and PAC model discovery.
- [ ] Prepare only the necessary connection credentials separately in a private Downloads directory. Never publish them or copy the controller's Claude login. Explain the access granted and safe transfer.
- [ ] Provide a copyable prompt for an agent on the other PC and test it on a second machine.
- [ ] Publish and verify the Windows prompt, required private-file names and existing-profile bootstrap from Git. These are published, and the bootstrap passed an isolated synthetic Windows profile test; a fresh real profile remains to be tested.
- [ ] Test startup, update, rollback, health diagnostics, credential rotation, and disaster recovery without losing conversations.

## Tracking

- [ ] Record the acceptance criteria and evidence in the existing Jira issue, with links to relevant commits and releases.
- [ ] Keep outstanding tasks and blockers current across interruptions and context compaction. An authentication request does not cancel independent work.
- [ ] Verify public GitHub commits use the 3ndetz identity, all intended changes are pushed, and touched repositories are clean.

The scenario list must grow when new risks or supported capabilities are discovered. Finite tests cannot establish a mathematical guarantee of zero defects; release readiness requires every applicable item above to have explicit evidence and unresolved limitations to be reported.
