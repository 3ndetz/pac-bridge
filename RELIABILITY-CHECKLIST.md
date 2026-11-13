# PAC Bridge reliability and acceptance checklist

This checklist tracks outstanding work for the OpenCode-first integration. A checked item requires a reproducible test against the deployed configuration and evidence linked from `ACCEPTANCE.md`. Unit tests alone do not prove an end-to-end scenario. Do not describe untested scenarios as complete.

## Required workflow

- [x] Verify the HAPI model-list probe uses its requested directory, preserves native models, and excludes PAC for an unsupported source policy on both installed runners. Real provider tests and the machine 4 wrapper correction are documented in [the evidence](ACCEPTANCE.md#provider-skill-checks-2026-11-12).
- [ ] Use the existing HAPI hub and select an existing registered source machine; do not create a separate hub to substitute for this workflow.
- [x] Create an OpenCode chat and select every currently advertised model from the intended PAC. On the first existing runner, all 13 IDs returned real replies in one HAPI chat, and controller model metadata observed during each corresponding turn matched the expected model, including alias resolutions. See [the evidence](ACCEPTANCE.md#relay-and-notification-checks-2026-11-13).
- [ ] Exercise real Claude responses, streaming, reading, writing, editing, shell, search, permissions, cancellation, follow-up, and model switching on the selected source machine.
- [ ] Verify the same flow on the other Windows machine through its own existing HAPI hub and runner, including restart and reconnect. A temporary runner attached to the first machine's hub does not satisfy this criterion.
- [ ] Detect expired controller authentication and show actionable guidance without logging credentials or replaying an uncertain turn.

## Context, recovery and durability

- [x] Verify manual compaction actually compacts the PAC conversation and retains a deliberately recorded fact in the next turn on the installed working runner. The existing runner on the first Windows machine and an isolated HAPI runner both passed with real Claude.
- [ ] Verify automatic compaction near the real context limit, including subsequent tools, instructions, skills, subagents, and session resume. Record model and limits used.
- [x] Exercise automatic compaction and context recall through HAPI with an artificially lowered test threshold; verify the completion notice is visible. This does not establish the production model's actual threshold.
- [ ] Verify session bindings, history, selected PAC and model survive runner, controller, relay, and Windows restarts without switching sessions or duplicating uncertain actions.
- [x] Diagnose the connection reset observed while loading a compacted session, and resume the same real-Claude session on each Windows machine with its skill, hook events, and remembered fact. See [the evidence](ACCEPTANCE.md#provider-skill-checks-2026-11-12).
- [x] Provide reviewed reconciliation for uncertain turns and verify on both Windows machines that the original session resumes without replaying a deliberately interrupted one-line action. See [the evidence](ACCEPTANCE.md#provider-skill-checks-2026-11-12).
- [x] Provide reviewed stale recovery-lock repair with automated live-owner, legacy and concurrency checks on Windows and Linux.
- [ ] Verify interrupted background and remote actions beyond the named one-line end-to-end test, including the rare case of a stale repair lock.
- [ ] Investigate the machine 4 ACP initialization that took approximately 168 seconds during a real HAPI session startup.
- [ ] Deploy and verify the independently tested Windows relay TLS-handshake recovery on the existing profiles without interrupting active sessions. A candidate completed a real Claude turn against the existing machine 4 hub; the installed relay is not yet updated. See [the evidence](ACCEPTANCE.md#relay-and-notification-checks-2026-11-13).
- [ ] Verify disconnection, reconnection, authorization expiry, model unavailability, concurrency, timeouts, and cancellation while actions are running. Confirm failures are explicit and recoverable.
- [ ] Resolve and retest slow HAPI archive acknowledgement on both installed runners. The HAPI session and all 17 observed child processes exited in about one second on the first machine, but the archive API returned 200 after 45 seconds; the second machine took 22 seconds. Inspect the runner confirmation path without weakening process ownership checks or patching HAPI for PAC.
- [ ] With the PAC relay unavailable, verify native OpenCode model discovery still works and the unavailable PAC is not advertised. This passed with the actual OpenCode ACP and an isolated synthetic native provider. The fix is staged for the next runner start on both Windows profiles; it is not yet verified in the running profiles.
- [ ] Store durable bindings and installation outside temporary build and checkout paths; preserve existing session bindings during migration.
- [x] Keep the verified PAC runner selected through a same-version managed kit repair, and reject a damaged pin or an incompatible base version. This was checked on the existing profile on the first Windows machine and in isolated installer tests.

## Instructions, skills and hooks

- [x] Confirm actual Telegram delivery for an OpenCode PAC turn using the existing local Codex notification sender. This covers the verified sender and turn, not all native OpenCode hooks. See [the evidence](ACCEPTANCE.md#relay-and-notification-checks-2026-11-13).

- [x] Discover file-backed skills nested in source directories and from ancestor project directories, respecting the nearest Git boundary and nearer project definition. Compare against the installed OpenCode and verify an ancestor skill invocation with real Claude. See [the evidence](ACCEPTANCE.md#provider-skill-checks-2026-11-12).
- [x] Discover and invoke the installed OpenCode built-in `customize-opencode` skill with real Claude without granting a filesystem root. See [the evidence](ACCEPTANCE.md#provider-skill-checks-2026-11-12).
- [ ] Inventory the actual installed OpenCode version's project and global instructions, skill search paths, metadata, plugin and hook events, tool permissions, and precedence.
- [ ] Implement and test each supported capability end to end on the source machine, including skill resources and before/after tool hooks. Explicitly reject or clearly warn about unsupported security-relevant configurations rather than silently skipping them.
- [ ] Implement and verify global Claude Code hook forwarding. The user's global `~/.claude/settings.json` is not currently forwarded; this also applies when the workspace is the home directory. Project-local settings remain checked. The separate Telegram completion notifier is not general global-hook support.
- [ ] Verify project `UserPromptSubmit` hooks through both installed HAPI runners after deployment. On the first runner, the selected installed provider and controller blocked a prompt and delivered hook-provided context in a real Claude reply; the temporary launcher only disabled test notifications. The second profile remains unverified for this event.
- [ ] Verify project instructions, scoped rules, hooks and skills before and after compaction and resume, for main agents and subagents, with allow, deny, and failure cases.
- [ ] Document exactly which OpenCode and Claude capabilities are supported, unsupported, or not yet verified; do not claim complete parity without evidence.

## Installation and operation

- [ ] Replace the modified HAPI runner, hub and UI with integration using unmodified, normally updateable HAPI. Keep integration behavior in PAC Bridge or supported extension interfaces; do not patch HAPI source or distribute a custom HAPI binary.
- [ ] Verify model discovery, streamed answers, tools, permissions, questions, context compaction, session recovery, background tasks and Telegram notifications end to end with the unmodified HAPI. Record unsupported behavior instead of claiming parity.
- [x] Start and stop a real PAC background shell task from the installed OpenCode runner on the second machine against its corporate baseline hub. A delayed test file was not written after the original command deadline. This verifies the provider command path, not the old PAC-specific task-control UI.
- [ ] Test HAPI and OpenCode version updates and rollback with existing sessions and machine identity preserved. Keep the existing deployment until this migration is verified.
- [ ] Provide versioned, reproducible installation from the repository using scripts and existing runtimes. Avoid a custom standalone executable or PAC Bridge archive; verify dependencies and explain any unavoidable platform runtime.
- [x] Stage and repeat the POSIX source installer on Linux with synthetic connection files and a native executable fixture. See [the evidence](ACCEPTANCE.md#provider-skill-checks-2026-11-12).
- [x] Exercise installed Linux launcher with real OpenCode, a synthetic TLS PAC response and native-model fallback when its PAC token is absent. See [the evidence](ACCEPTANCE.md#provider-skill-checks-2026-11-12).
- [x] Exercise installed Linux launcher against the authenticated PAC through ACP, including a project skill, its resource, and project pre-tool and post-tool hooks for Skill and Read. See [the evidence](ACCEPTANCE.md#provider-skill-checks-2026-11-12).
- [ ] Verify the POSIX installer with an authenticated PAC and existing HAPI runner on Linux and macOS, including upgrade and restart; verify macOS execution separately.
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
