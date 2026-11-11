# PAC Bridge reliability and acceptance checklist

This checklist tracks outstanding work for the OpenCode-first integration. A checked item requires a reproducible test against the deployed configuration and evidence linked from `ACCEPTANCE.md`. Unit tests alone do not prove an end-to-end scenario. Do not describe untested scenarios as complete.

## Required workflow

- [ ] Use the existing HAPI hub and select an existing registered source machine; do not create a separate hub to substitute for this workflow.
- [ ] Create an OpenCode chat and select every available model from the intended PAC, with the named PAC and actual selected model matching throughout the turn.
- [ ] Exercise real Claude responses, streaming, reading, writing, editing, shell, search, permissions, cancellation, follow-up, and model switching on the selected source machine.
- [ ] Verify the same flow from another Windows machine joined to the same HAPI hub, including restart and reconnect.
- [ ] Detect expired controller authentication and show actionable guidance without logging credentials or replaying an uncertain turn.

## Context, recovery and durability

- [x] Verify manual compaction actually compacts the PAC conversation and retains a deliberately recorded fact in the next turn on the installed working runner. The existing 1C-Prog runner and an isolated HAPI runner both passed with real Claude.
- [ ] Verify automatic compaction near the real context limit, including subsequent tools, instructions, skills, subagents, and session resume. Record model and limits used.
- [ ] Verify session bindings, history, selected PAC and model survive runner, controller, relay, and Windows restarts without switching sessions or duplicating uncertain actions.
- [ ] Verify disconnection, reconnection, authorization expiry, model unavailability, concurrency, timeouts, and cancellation while actions are running. Confirm failures are explicit and recoverable.
- [ ] Store durable bindings and installation outside temporary build and checkout paths; preserve existing session bindings during migration.

## Instructions, skills and hooks

- [ ] Inventory the actual installed OpenCode version's project and global instructions, skill search paths, metadata, plugin and hook events, tool permissions, and precedence.
- [ ] Implement and test each supported capability end to end on the source machine, including skill resources and before/after tool hooks. Explicitly reject or clearly warn about unsupported security-relevant configurations rather than silently skipping them.
- [ ] Verify project instructions, scoped rules, hooks and skills before and after compaction and resume, for main agents and subagents, with allow, deny, and failure cases.
- [ ] Document exactly which OpenCode and Claude capabilities are supported, unsupported, or not yet verified; do not claim complete parity without evidence.

## Installation and operation

- [ ] Provide versioned, reproducible Windows setup instructions and a tested archive in this repository's release assets. Pin and verify executable artifacts and dependencies.
- [ ] Join the existing hub without creating a new hub, overwriting an unrelated configuration, or copying machine identity; verify machine selection and PAC model discovery.
- [ ] Prepare only the necessary connection credentials separately in a private Downloads directory. Never publish them or copy the controller's Claude login. Explain the access granted and safe transfer.
- [ ] Provide a copyable prompt for an agent on the other PC and test it on a second machine.
- [ ] Test startup, update, rollback, health diagnostics, credential rotation, and disaster recovery without losing conversations.

## Tracking

- [ ] Record the acceptance criteria and evidence in the existing Jira issue, with links to relevant commits and releases.
- [ ] Keep outstanding tasks and blockers current across interruptions and context compaction. An authentication request does not cancel independent work.
- [ ] Verify public GitHub commits use the 3ndetz identity, all intended changes are pushed, and touched repositories are clean.

The scenario list must grow when new risks or supported capabilities are discovered. Finite tests cannot establish a mathematical guarantee of zero defects; release readiness requires every applicable item above to have explicit evidence and unresolved limitations to be reported.
