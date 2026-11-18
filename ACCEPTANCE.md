# Acceptance criteria: cross-platform transparent agent bridge

## Workspace reconciliation checks (2026-11-17)

The full scoped Node suite passed on Linux at `e950821`: 369 tests, 305 passed, 64 skipped, zero failures. It ran in a container without external networking. The final Windows suite at `e5468ff` also passed: 369 tests, 331 passed, 38 skipped, zero failures. It ran inside an owned Job Object with a disposable enclosing HOME, explicit Git Bash executable and no inherited provider credentials; zero active processes and host exit were confirmed before removing the test root. Native SDK/live opt-ins were disabled.

The initial Windows verification environment produced six duplicate-skill errors because its HOME was a sibling of the test temp directory and a Bash error because LOCALAPPDATA pointed to an empty profile. Correcting the enclosing HOME and selecting the existing Bash executable removed those failures. A subsequent full run exposed an intermittent synthetic transcript readiness failure. The fixture now confirms its written bytes using its owning handle, publishes a separate readiness marker and closes its job even when readiness fails. The final full run above includes that fix; the earlier readiness failure is not evidence of a production transcript implementation.

The retained POSIX installer candidate's separate synthetic Python suite ran in a network-isolated container: 37 cases, 36 passed, one skipped. Its installer design remains experimental and is separate from the scoped product test suite and real HAPI acceptance.

Nine synthetic comparison, ACP-disconnect, stdout-EOF and router snapshot tests passed in a Linux container without external network access. The process-lifecycle scenarios are explicitly scoped to Linux. The two context-comparison tests also passed natively on Windows and do not disclose identity, path, model or credential values.

Seventeen Windows owned-preparation tests passed. They exercised staging, extraction, hashing, control timeouts and loss of the owner's loopback connection. Their own retained Job Object reported zero active processes before verified-root cleanup. Two related scenarios were repeated after bounding the nested job's lifetime. These are test-harness results, not proof that production HAPI uses that ownership contract.

Seven optional native SDK and synthetic-model probes were checked with their scenario flags removed: all seven were skipped and no model scenario ran. Their source and opt-ins are documented in [runtime probes](docs/runtime-probes.md); skips are not runtime acceptance.

Earlier uncommitted live-runtime and cross-host draft notes were preserved privately with the corresponding task-local probe sources. They were not independently reverified during this reconciliation and are not added as release evidence. [Workspace reconciliation](docs/workspace-reconciliation.md) explains what was retained as regression coverage and what remains unsupported.

## Relay and notification checks (2026-11-13)

An isolated candidate controller running on the existing PAC used its existing Claude login. A source project `UserPromptSubmit` hook blocked one prompt and supplied a marker that appeared in an authenticated Claude response to the next prompt. The source hook and controller communicated directly over a temporary connection; the installed HAPI runners and active controller were not changed. The installed HAPI path and other hook events remain open.

A second test used the existing Windows machine and HAPI runner with a temporary launcher, temporary loopback relay, and the candidate controller on the same PAC. The source project hook blocked the first prompt; a real Claude response to the second prompt appeared in HAPI with the hook-provided marker. Test notifications were disabled for the temporary launcher, and HAPI reported the test chat archived. This verifies the candidate path in that runner, not deployment to the installed provider or the other Windows profile.

The reviewed controller adapter was then atomically installed on the existing PAC with its previous file retained as a verified backup; existing controller processes were not restarted. The source provider revision was staged and selected for new chats on the first Windows runner without restarting it. A further HAPI chat used a temporary silent launcher that read that installed provider pointer, the existing relay and the installed controller. The project prompt hook blocked a request and supplied the marker in a real Claude reply. HAPI confirmed the test chat archived and its temporary workspace was removed. The second Windows profile remains to be updated and verified.

On machine 4, an existing HAPI session was started through a temporary instance of the reviewed relay transport against the same existing hub. The TLS agent recovered one connection reset before any HTTP request was sent; OpenCode received a real Claude reply and the test session was archived. The recipient confirmed delivery of the Telegram completion notification for that actual turn. Earlier delivery of a synthetic Codex `Stop` event was also confirmed. These results cover the specific sender and scenarios exercised, not every OpenCode or Codex hook.

The separately published relay candidate recovered pre-handshake resets in tests while preserving one delivery per HTTP request, including concurrent requests, cancellation and WebSocket upgrade. The actual machine 4 relay and the shared gateway have not yet been updated; other active sessions must be preserved during rollout. The release and outstanding work are tracked in the internal issue tracker.

On the HAPI runner on the first Windows machine, one temporary OpenCode chat selected all 13 PAC model IDs then advertised and received a real reply for each. The test used the installed provider code with completion notifications disabled only in its temporary launcher; the chat was archived. This test confirms selection and replies for those IDs; the controller's model metadata was checked separately below. The opt-in Windows procedure is documented in [windows-setup.md](docs/windows-setup.md).

A separate direct ACP check selected all 13 IDs on the same PAC, received a distinct requested marker for every turn, and inspected the controller's `_claude/model` usage metadata after each turn. `default` and `opus` resolved to `claude-opus-5-5`; `sonnet`, `haiku`, and `fable` resolved to `claude-sonnet-5-5`, `claude-haiku-5-5`, and `claude-fable-5-1`, respectively. The remaining eight IDs each matched their reported model: `claude-haiku-4-5-20251001`, `claude-sonnet-5`, `claude-opus-5`, `claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, and `claude-sonnet-4-6`. This reports the authenticated runtime's model metadata for the tested turns; the direct check and the earlier HAPI check were separate, and do not prove future catalogs or model routing.

A subsequent single-chat HAPI check selected all 13 IDs on the first existing runner, received a distinct marker for every model, and captured the `_claude/model` metadata in the bridge trace for each corresponding turn. All 13 matched the resolutions above. The temporary launcher read the installed provider revision and disabled test notifications; the chat was archived and its workspace removed. This covers the models and runtime exposed during this check, not models added later or every other client.

## Live checks on an existing second Windows profile (12 November 2026)

An existing Windows HAPI profile retained its hub and runner identity while receiving the PAC integration. Through its actual runner, real Claude selected a PAC model, wrote a source file, completed manual compaction and recalled a marker. The same real-Claude session path invoked an OpenCode project skill and read its bundled resource, executed a post-write hook, enforced a pre-read denial without exposing the file contents, and executed a post-read-failure hook. Reinstalling the managed kit retained the pinned PAC runtime; a subsequent real-Claude compaction and recall check passed. These are API and runner checks; the create-chat UI, Windows reboot, all skill metadata and native OpenCode plugin hooks are not covered.

An optional source-side completion sender was exercised on that profile after real PAC responses. Telegram accepted the test notifications and the sender verified the returned text. Credentials remained in a protected local profile and were not published. This callback covers completed PAC turns, not every OpenCode or Codex hook event.

## Latest live verification (11 November 2026)

An isolated HAPI runner using the PAC compaction extension sent `/compact` to the remote Claude session, received a confirmed compaction result and recalled a marker recorded before compaction. An independent direct ACP test also observed a completed compaction and recalled its marker. The corrected HAPI runtime and PAC router were then installed on the existing runner on the first Windows machine; a disposable session created through that runner selected the PAC model, completed `/compact` and recalled its marker. Existing agent processes need a restart to pick up the new runtime. Automatic compaction near the context limit and preservation of every instruction and tool after compaction remain unverified.

With a disposable controller on the same PAC and an artificially reduced compaction threshold, real Claude automatically compacted its conversation through an isolated HAPI runner, HAPI displayed the completion notice, and the next turn recalled a marker recorded before compaction. A direct ACP test also observed automatic compaction and returned a marker. The production default threshold and context preservation for every possible conversation are not established by these tests.

An isolated real Claude session created through HAPI discovered and invoked a simple project skill from `.opencode/skills`. Unit tests also cover `.opencode/skill`, `.agents/skills`, project-over-global precedence and duplicate project-name rejection. A separate isolated real Claude session discovered a global OpenCode skill and read an auxiliary file within that invoked skill's directory. Additional skill frontmatter, arbitrary global resource locations and full OpenCode plugin hook parity remain unverified or unsupported.

An isolated real Claude HAPI scenario combined a project OpenCode skill with supported Claude project hooks, including post-tool, denial, hook failure and tool-failure cases. It then compacted the PAC conversation, resumed the session, recalled context, wrote a source file and invoked the skill again. Other hook types and plugin implementations are not covered by this scenario.

Turn completion now waits for already-received ACP notifications to be delivered before releasing its update handler. Unit coverage includes nested RPCs from notification handlers, and the selected-PAC background-event regression passed three repeated runs. The combined real-Claude HAPI hook, skill, compaction and resume scenario passed again after this change.

The existing source runner's 20 PAC session-binding files were moved from the development checkout into its protected persistent HAPI profile and verified by SHA-256. A junction at the former path preserves access for already-running sessions. The runner was restarted gracefully and the existing hub connection was verified. A full Windows reboot and recovery of existing conversations across that reboot remain unverified.

The managed ServerMallAgents kit now supports a profile-specific runtime pin. On the existing profile on the first Windows machine, reinstalling the published `0.34.4-sm4` kit retained the PAC runtime checksum and persistent binding configuration, and the existing hub connection verified successfully. A mismatched base version, missing binary or checksum mismatch stops the update for review. This does not prove automatic recovery after every possible operating-system or network failure.

Configured OpenCode plugins are not executed by the PAC route. A guard checks configured plugin entries and plugin directories before a PAC turn or manual compaction and stops with an explicit message if found, rather than silently bypassing their hooks. An isolated HAPI test confirmed the warning and an unchanged source file. The guard also refuses configured OpenCode permissions, extra instruction paths, MCP servers and custom skill settings that the bridge cannot yet preserve. This guard does not implement the OpenCode plugin API or prove discovery of every possible custom configuration.

The existing runner on the first Windows machine was updated to HAPI 0.34.4 with the PAC ACP text forwarding fix ([HAPI commit](https://github.com/3ndetz/hapi/commit/33cc071e)). The existing first hub connection and runner lifecycle readiness passed the kit verification. A disposable session created through that same machine selected PAC Opus and returned a visible assistant response mentioning the `C:` source drive. A separate real Claude ACP check returned the source `C:\` workspace. The test session was archived and existing conversations retained. Existing conversations started on an older executable require a new chat to pick up the fix.

The existing runner was subsequently switched to persistent source files, an enabled relay service and a controller logon task. A real Claude file-operation and text test passed through the new relay before and after independently restarting the relay and controller. A new session on the existing HAPI machine then returned an Opus answer through this configuration. This is a live smoke test, not full acceptance: operating-system reboot and unattended controller boot have not been verified, and the other requirements below remain open wherever not explicitly verified.

In a separate local HAPI 0.34.4 run through the same authenticated controller, real Claude followed source instructions and rules, invoked a source skill, and exercised post-tool hooks, hook denial, hook failure blocking and tool-failure hooks. The installed HAPI runner and web were subsequently updated to preserve and display PAC discovery warnings. A browser check of the existing public HAPI confirmed that an invalid project rule produces a visible warning alongside the native model selector. A closed ACP input pipe was also fixed so an unavailable agent cannot crash the runner; its regression tests and an isolated HAPI run passed.

After deployment, a browser check on the existing machine selected OpenCode, observed the `PAC #1` Opus label, created a session and archived that empty verification session. A separate real-controller HAPI run verified source Glob, Grep and shell output and file effects, then resumed the conversation with the selected PAC model and another source tool call. These checks do not replace the remaining acceptance scenarios.

## Objective

Connect remote agent clients and an authenticated Claude Code runtime through PAC Bridge. Forward commands, tool calls, events and their results rather than relying on a shared filesystem or copying entire workspaces between machines. The bridge must preserve the semantics of the participating agents, including their background work and subagents.

Multiple independently authenticated Claude Code runtimes can coexist as named PACs. Clients on different machines must be able to discover and explicitly select a PAC and its model from OpenCode or another supported harness. A PAC name is a human-readable label for a stable identity, not an authentication credential.

A user must be able to create a real HAPI session on a chosen machine by selecting a supported installed harness and then selecting a model entry such as `PAC_<name>/<model>`. The entry selects the named remote Claude runtime and its model; it must not require Claude authentication on the source machine. Creating a session on the PAC host instead is not a substitute for this workflow.

The required visible workflow is HAPI → create chat → OpenCode → select `PAC #N / <model name>` from the model list. Show every model actually available from each authorized PAC, with its own PAC identity, name and availability. Catalog discovery and routing must not assume all future models are Claude: a PAC may later offer Codex or another family through an appropriate runtime. Confirm the selected model is actually used, and do not invent unavailable models or credentials. Existing `PAC_<name>/<model>` identifiers are internal implementation details.

The existing HAPI machine identity, for example the first Windows machine, must remain the selected machine: no extra machine, runner identity or HAPI instance may be required. The models appear in that machine's ordinary OpenCode list in the real create-chat screen, alongside existing models. Preserve running chats. Test this exact UI flow and an actual model response; terminal-only, separate-runner and API-only demonstrations are not acceptance.

Known delivery mistakes to prevent: a terminal-only launcher was presented after HAPI had been requested; a separate runner was registered as an extra machine; test-only or API-only evidence was treated as though the original machine's HAPI UI were ready; and a temporary relay was presented without a durable deployment. None establishes the required workflow. Keep skills, hooks, cancellation and supported model families in the acceptance matrix and report incomplete scenarios explicitly.

In an authenticated Windows source session rooted at `C:\\`, Claude first attempted the controller's working directory instead of the source workspace. A subsequent direct ACP test still returned the controller path when asked for the user's workspace, even after a source-workspace instruction had been added and delivered to the model in a synthetic SDK test. The controller's own environment context remains misleading; source workspace identity is not yet accepted as fixed. Text chunks were observed being routed before turn completion, but the installed HAPI session did not show them in the tested path; a direct ACP test did receive text. The loss in HAPI remains open.

Also prevent recurrence of the earlier direction and publication errors: OpenCode is the agreed first target and work on OMP requires the user's confirmation. Public GitHub commits must use the 3ndetz GitHub identity; verify both author and committer before publishing. Do not interrupt the requested implementation to declare a partial proof complete.

The user must also be able to launch OpenCode locally in its normal interactive interface and select and use a named PAC's Claude from there. A HAPI session that drives OpenCode through ACP does not by itself establish that the OpenCode terminal interface supports this workflow. Verify the actual interactive launch, model selection, streaming, workspace tools, permissions, cancellation and resume with a remote authenticated Claude runtime; do not require Claude credentials on the source machine or copy them there.

The destination harness must provide functionality at least equivalent to the Claude Code functionality being bridged, including the ability to represent and control every required operation and lifecycle. A richer or different harness is not automatically equivalent: parity must be demonstrated for each feature and direction, and missing behavior blocks acceptance.

The public project must not contain private infrastructure details, credentials or session data. Docker is optional, not a prerequisite.

## Functional requirements

1. An OpenCode client or another supported harness can select a named PAC and any model available through that specific PAC. Discovery, model identifiers, capabilities, selection, changes, errors and availability must be reflected accurately per PAC; different PACs may expose different models and authentication. The selected PAC and model must be used by the actual runtime, not merely displayed in the client.
2. A request reaches the intended authenticated Claude runtime, and response text, streaming updates, tool calls, tool results and errors return to the originating client and session.
3. All supported tools must be forwarded with their actual inputs, outputs, errors, progress, permissions and cancellation semantics. This includes read, write, edit, search, shell, interactive questions and any other native, MCP or dynamically registered tools. Interactive questions must carry choices, free-text and multi-select answers where supported; an allow/deny permission prompt is not a substitute. A tool call must execute on its intended side in the intended workspace, without silently falling back to the wrong machine.
4. All tasks, background processes and subagents, including nested and parallel work, must be represented end to end: creation, identities, parent relationships, status, incremental output, results, failures, approvals, cancellation and resumption where available. They must not be reduced to a final text summary or disappear when a turn finishes.
5. Multiple clients and sessions must remain isolated. Reconnection must restore observable state or report what cannot be recovered; it must not silently duplicate side effects. An uncertain outcome must be reported as uncertain rather than retried blindly.
6. Windows, macOS and Linux must be supported as both controller and workspace hosts. Path syntax, working directories, quoting, encodings, exit codes and process lifecycle must be handled for the target operating system. Git Bash may be an optional shell, not a substitute for platform-correct tool semantics.
7. Existing Claude Code authentication stays on its host. Secrets are neither copied to clients nor exposed in logs. Transport must authenticate peers, protect traffic, enforce permissions and make security-relevant actions auditable.
8. Capabilities and incompatibilities must be explicit. Unsupported behavior must fail visibly, not silently degrade; full parity is not accepted until all required behavior is verified. No shared filesystem, direct cross-machine file access or workspace synchronization is required for normal operation.
9. PAC registration must provide a stable unique identity and a configurable, human-readable name. Define and enforce name uniqueness or unambiguous disambiguation, collision handling and rename behavior. Discovery must show identity, name, connection status and available models only to authorized clients; offline or stale entries must not appear usable.
10. A client can connect to a chosen PAC from any authorized machine, and multiple clients can use one or several PACs concurrently. Sessions, model choices, task and subagent trees, tool calls, permissions and events must remain bound to the correct PAC and client session. Concurrent-use and authorization rules must be explicit, including what happens when a PAC is busy, disconnects, reconnects or is renamed. No silent switch to another PAC or model is allowed.
11. Full functionality means every feature exposed by the selected runtime and supported client must be transported, not just a predefined list of tools. This includes new or dynamically introduced capabilities and their lifecycle. Capability negotiation must identify any gap; a capability that cannot be represented end to end blocks a full-parity claim.
12. Hooks, skills, instructions, custom commands and extensions must retain their intended execution context, inputs, outputs, ordering, side effects, configuration, failures and permissions. Discover and route each feature to its owning runtime or workspace without silently substituting an unrelated local feature. Forward associated events and results to the appropriate session. Background and nested execution of these features is subject to the same lifecycle and isolation requirements as other work.

## Acceptance tests

- Exercise an actual OpenCode client and authenticated Claude Code runtime on separate hosts. Verify model enumeration, explicit selection, a streamed response and error propagation.
- Invoke read, write, edit and search on a fixture that exists only in the intended workspace. Verify exact inputs, output and side effects, and prove that the other host's similarly named fixture is untouched.
- Execute successful, failing, long-running and cancelled commands. Verify working directory, output streaming, exit status, cancellation and cleanup on Windows, macOS and Linux.
- Start multiple concurrent background jobs and nested subagents, observe live status and partial output, collect each result, cancel one branch and confirm the other branches continue. Repeat through reconnect and session resume; verify parent-child identities, no lost results and no duplicate side effects.
- Exercise a dynamically registered or MCP tool and a permission prompt, including approval and denial. Verify the correct client sees the prompt and the resulting decision reaches the correct invocation.
- Ask an interactive question with choices, free-text and multi-select answers through the originating client; verify the exact answer reaches the intended remote invocation, including cancellation and concurrent sessions.
- Exercise configured hooks and skills, including successful and failing hooks, ordering, permissions, configuration and side effects in their intended execution context. Verify custom commands, instructions and extension events; ensure a missing or unsupported feature is explicitly reported rather than silently ignored.
- Run simultaneous sessions from multiple clients and verify isolation, access control and cancellation boundaries.
- Register at least two separately authenticated PACs with distinct names and model catalogs. Connect clients from at least two machines using OpenCode and, when supported, another harness. Select each PAC and model explicitly, prove execution reaches the intended runtime, and check that model changes and unavailable models are reflected correctly without cross-routing.
- In HAPI, create a session on each of two source machines with an installed supported harness, choose a `PAC_<name>/<model>` entry in the model selector, and verify the actual remote Claude runtime and selected model. Neither source machine may need Claude credentials. Verify the complete tool, task, subagent, hook and skill matrix through that same HAPI session.
- Run concurrent sessions and nested background work across both PACs; verify each event, approval, result and cancellation reaches only its owning client, session and PAC. Test unauthorized discovery and connection, duplicate names, rename, disconnect/reconnect, offline state and recovery without changing identity or silently selecting another PAC.
- Interrupt the transport during a side-effecting call and verify safe reconciliation or an explicit unknown outcome; verify errors never masquerade as success.
- Run the cross-platform matrix with native installations and no Docker or shared filesystem. Publish automated test results and document any gaps; partial coverage does not constitute acceptance.

## Harness evaluation

Compare OpenCode, Pi and Oh My Pi using the same end-to-end scenarios above. Evaluate their actual tool interception and routing, authentication compatibility, model discovery, task and subagent lifecycle, permissions, streaming, reconnection, cross-platform operation and maintainability. An adapter that routes its own tools is not evidence that it can intercept Claude Code's native tools. Select the architecture only after a working proof of concept demonstrates the required direction of calls and results.

Maintain an evidence-backed feature matrix against the actual Claude Code version in use, covering hooks, skills, background tasks, subagents, filesystem requests, shell, MCP, approvals, session management, model selection and any other exposed feature. Record the behavior, execution side, mapping, tests and unresolved gaps for each harness. Do not claim a harness is at least as capable as Claude Code based solely on a list of similarly named features.

## Current evidence and gaps

The experimental fixtures are not a release and do not satisfy this acceptance contract. Results below describe isolated tests, not installation in the user's production HAPI.

The experimental OpenCode launcher can discover configured PAC models directly without starting a second OpenCode process. A synthetic endpoint test covers discovery and an unavailable endpoint; a local fake-PAC CLI test exercised a tool approval. Source project hooks, skills and instructions are enabled during launcher setup, with unsupported configurations rejected. Controller authentication errors are reported without retrying an uncertain turn. The direct discovery path still opens and closes a controller session; its longer-term effect on controller authentication and the complete real-runtime regression remain unverified. The test controller subsequently reported that Claude was logged out, including with the older discovery path; the cause has not been established.

After the test controller was signed in again, an isolated cross-host OpenCode text turn succeeded through direct discovery and its login remained present afterward. The first rerun exposed status notices interleaved inside streamed words; the provider now defers and deduplicates these notices until the answer completes, and the repeat run verified the exact response. This single check does not establish the cause of the earlier logout or complete the controller regression.

An installed OpenCode server displayed two native questions requested by a synthetic PAC, and returned a free-text answer and multiple selected answers to that PAC through the session-bound adapter. Separate server tests rejected a question and aborted a session while a question was open; both verified that cancellation reached the synthetic PAC. Unit tests cover cross-session rejection. This does not yet verify an authenticated Claude question, the terminal UI, subagent questions or all cancellation races. If OpenCode does not expose its question tool, the adapter rejects the request rather than presenting it as an approval.

The experimental controller adapter is now in `adapters/pac-claude-agent.mjs`; the old test entrypoint imports it and retains its test-only delay. An isolated cross-host run reached the remote prompt through the moved adapter but failed at controller authentication. This verifies the exercised startup and routing path, not a successful Claude response after the move.

The controller's ACP and Claude SDK dependencies are pinned in the project lockfile; its initialization passed using those installed dependencies without signing in. With an isolated local synthetic Anthropic-compatible endpoint, the installed controller completed a text turn and invoked its source Read tool; the synthetic endpoint received the source result on the following request. The pinned ACP package's Zod dependency is overridden to a patched version, and the current production dependency audit reports zero vulnerabilities. An authenticated end-to-end run with this exact installation remains outstanding.

An installed OpenCode server switched from one synthetic model to another on the same synthetic PAC within one conversation, retaining a context marker. A separate test restarted OpenCode and the launcher, restored a synthetic PAC conversation and then switched models with the original context. Unit tests cover persistence of that selection and refusal to switch to a different PAC. Model switching with an authenticated controller remains unverified.

Aborting an active OpenCode server session delivered ACP cancellation to a synthetic PAC while its turn was pending. This does not establish that a real controller's in-progress side effects or descendant processes have stopped; those require separate verification and an interrupted outcome can remain unknown.

Another test killed OpenCode and its launcher during a synthetic PAC turn, restarted them and attempted to continue the same session. The user-facing response reported an unknown prior outcome and the synthetic PAC observed only one turn start. This does not prove reconciliation of a real side effect or recovery of background work.

An installed OpenCode server represented a synthetic PAC `agent_thought_chunk` as a reasoning part while also preserving the final response. Real-runtime reasoning, mixed content and multi-step streaming remain unverified.

Two simultaneous sessions in the installed OpenCode server each received only its own distinct prompt marker from separate synthetic PAC sessions. Separate simultaneous-question and simultaneous-permission tests returned distinct answers and approve/deny decisions only to their owning synthetic sessions; both scenarios also passed between separate Windows hosts through an isolated TLS relay. Real-controller concurrency and broader cross-machine isolation remain to be verified.

In a separate installed OpenCode server test, two concurrent sessions selected different models on two named synthetic PAC processes and received their respective controller markers. The scenario also passed between separate Windows hosts through an isolated TLS relay. This is routing evidence only; it does not establish two independently authenticated Claude accounts.

In an isolated cross-host OpenCode run, a synthetic PAC verified that the source fixture was not visible on the controller, read and searched it through the bridge, requested an approved write, and ran successful and failing source-side shell commands with verified output and exit status. The source-side test independently verified the resulting file contents. A separate denied-write run verified that the source file stayed unchanged. This covers the exercised paths, not full tool semantics or an authenticated Claude run.

The provider can translate a bounded inline PNG, JPEG, GIF or WebP input to an ACP image block in a unit test. With explicit experimental image capability enabled, an installed OpenCode server and `run --file` each forwarded a valid PNG to a synthetic PAC. A separate isolated run forwarded the PNG from one Windows host through a TLS relay to a synthetic PAC process on another Windows host. An earlier `BadRequest` was traced to an invalid test PNG; a valid PNG was initially omitted because the synthetic model was advertised as text-only. A further CLI test checks that the plugin rejects this attachment when image capability is unknown. Automatic capability discovery, authenticated Claude image input, the terminal UI and realistic size limits remain unverified; the explicit test flag does not establish that every remote model accepts images.

On Windows, the installed OpenCode 1.19.5 selected a configured local OpenAI-compatible synthetic provider, displayed its streamed response in `opencode run`, and executed a synthetic provider's request to read an isolated fixture, returning the result on the next provider call. The optional `test/opencode-provider-probe.test.mjs` uses a loopback server, synthetic credentials and no external model. OpenCode also made a separate request without tools, so a future bridge must distinguish auxiliary requests from user turns rather than start extra remote operations. This checks local provider selection, text streaming and one local tool call, not the interactive TUI, PAC routing, native Claude tool events or permissions.

An isolated cross-host test subsequently launched the installed OpenCode CLI through the experimental PAC provider, selected `PAC_testpac/sonnet`, and received a requested text marker from an authenticated Claude Code runtime on another host. Source credentials were not copied. This was a single text-only turn, not an interactive TUI or a tool, permission, reconnect, or complete acceptance test. Remote slash commands and usage metrics currently produce explicit limitations; unsupported events terminate the turn.

A second isolated CLI run asked the same remote Claude to read a fixture present only in the OpenCode workspace, observed a PAC tool event, and received a confirmation marker. Tool events are currently rendered as structured text, not native OpenCode tool cards; commands and subagents are not validated through this route.

An experimental approval bridge splits a remote turn into OpenCode provider response segments, asks through an OpenCode plugin tool and sends the chosen allow-once or reject-once option back to the originating PAC. Isolated tests with OpenCode and a fake PAC exercised automatic approval and an explicit deny policy. Separate cross-host runs with real Claude verified a source-side file write under automatic approval and verified that a denied write did not create the file. Interactive TUI approval, cancellation while an approval is visible, other approval variants, concurrent sessions and reconnect remain unverified.

Another isolated CLI run used automatic approval for a Bash command from remote Claude and verified the resulting file in the local source workspace. This does not validate interactive approvals, failure and cancellation paths, background commands or other operating systems.

In a further isolated run, two messages sent through one OpenCode server session reached the same remote Claude conversation: the second response recalled a marker supplied only in the first prompt. This verifies sequential in-process context for that path, not restart, reconnect or active-work recovery.

The same test was repeated after stopping and restarting the isolated OpenCode server and PAC launcher between messages. The saved PAC and ACP session binding restored the completed Claude conversation and its first-turn marker. Recovery of an interrupted operation and reconciliation of uncertain side effects remain open.

The launcher now records an exclusive pending-turn marker before sending a prompt and clears it only after a confirmed normal completion. Unit tests verify that a failed turn leaves the marker and a new router refuses to repeat it; the completed-conversation restart scenario also passed with the marker enabled. This is fail-closed detection, not automatic reconciliation or a cross-host crash test of every side-effect timing.

On Windows, a pseudo-terminal run of the standard OpenCode TUI displayed the experimental PAC model and a permission prompt, and separate manual interactions selected allow and reject against a fake PAC. A request summary is shown in the conversation before the prompt. The test does not establish a real-Claude TUI approval, cross-platform terminal behavior, or complete rendering of lengthy approval details.

The launcher probes registered endpoints before startup, displays unavailable endpoints separately, and requires an explicit model choice if `PAC_MODEL` is not supplied. An isolated pseudo-terminal test selected a model from the discovered fake PAC catalog and continued into OpenCode. Model availability can still change after this initial probe; the session-opening path checks the selected PAC again.

A Windows pseudo-terminal run with the actual remote Claude displayed an interactive write approval; after selecting allow, the local fixture contained the expected text. The TUI exit interrupted the test supervisor before its normal cleanup and returned a nonzero status; remote test directories were subsequently checked and cleaned separately. Terminal shutdown and cleanup remain unresolved.

| Capability | Evidence | Remaining acceptance work |
| --- | --- | --- |
| Session creation and models | Real HAPI runners on two Windows source hosts offered and selected a named PAC model before session creation. Browser tests on both hosts selected OpenCode and the PAC model in HAPI's new-session form, created a session, sent a message and stopped the resulting task; component tests also cover selection and form submission. A separate live session switched from Sonnet to Opus and back; Claude usage events confirmed the actual model family after each switch. | Persistent deployment, live discovery and authorization; independently authenticated PAC identities, all model variants and broader source platforms. |
| Discovery errors | The experimental router returns bounded, non-sensitive reason codes for unavailable PACs and unsupported project instructions without removing native model choices. A cross-host HAPI API test observed an external-import warning; HAPI component tests cover displaying warnings with the local model picker and retry. | Production integration, browser-driven warning behavior, stale-catalog invalidation, all setup failures and independently authenticated controllers. |
| Completed session resume | A HAPI session resumed with its original PAC, selected model, conversation context and a subsequent source-side write. | Recovery during active work, disconnects, pending approvals, model changes and independent controllers. |
| Files and search | Cross-host source-side Read, Write, Edit, a limited Glob/Grep subset and a small PNG image read were exercised. | The prototype confines access to the selected workspace, which is not equivalent to native Claude Code permission-controlled access outside it. Atomic edits, other binary formats and large files, remaining search options, unsupported tools and cross-platform end-to-end coverage are also outstanding. |
| Approvals | HAPI allowed and denied foreground Bash; a denied workspace write had no effect. Aborting pending command and write approvals removed both prompts, rejected late approval and produced no side effects. Unit tests verify that a cancelled or disconnected write cannot start after a delayed approval. | Every tool, permission mode, concurrent prompt, timeout, disconnect and resume path. Do not deploy this prototype as a production permission boundary. |
| Shell streaming and cancellation | An isolated HAPI session received a running command's first output before completion, both at the root and in a child-scoped subagent; a reducer test retained progress on the running card. An HAPI abort stopped a running source command before its delayed side effect and cancelled pending foreground and background command approvals. | Browser rendering, mixed stdout/stderr ordering, truncation, disconnect and all platform-specific shell semantics. |
| Interactive questions | An opt-in MCP tool routed two questions through HAPI's permission API, receiving a custom answer and a multi-select answer; a separate question was denied and returned an error to the remote runtime. Aborting a pending question removed its prompt and rejected a late approval. The root tool ID and name matched the permission, a reducer test associated completed answers with the card, and a real subagent question carried a scoped identity and returned its answer. | Actual web UI interaction and nested-agent card association, other cancellation and disconnect paths, concurrency and complete native tool equivalence. |
| MCP transport | A local relay test forwarded tool calls, results and tool-list-changed notifications without rewriting the protocol. In a separate no-Docker HAPI test, authenticated Claude Code on Windows invoked a synthetic MCP server on another Windows host and then discovered and called its dynamically registered tool through the relay. | Integration with existing OpenCode-configured servers, permissions, resources, prompts, arbitrary real MCP servers and complete lifecycle behavior remain unverified. |
| Project hooks | A source-side PreToolUse command denied a read, a PostToolUse command ran after a write, and a PostToolUseFailure command received the source context and error after a failed read. The cross-host test verified that earlier pre-execution denials did not trigger the failure marker. Unit tests cover concurrent matches, deduplication and simple decision precedence. | Other output combinations, events and hook types, user/managed/plugin/skill scopes, exact precedence and failure semantics end to end. |
| Background subagents | Real background subagents read source-only files and their running/completed snapshots appeared in a patched HAPI. A separate test observed two background subagents running simultaneously and receiving both results. Tests requested cancellation through the experimental `TaskStop` alias, a patched HAPI API, and the actual HAPI browser control on both Windows hosts; the latter stopped a subagent after its source command began, observed interruption and prevented a delayed side effect. Unit tests cover task ownership and failure handling. | Nested and broader concurrent tasks, direct stop on other platforms, disconnect, recovery, full events and result isolation. The PAC `TaskOutput` alias also retrieves native subagent text from the current controller session; live output is held in memory, limited to 128 tasks and 262,144 characters per task; output after a session restart is recovered from that session?s SDK transcript. |
| Background shell | Source task lifecycle, output, timeout and stop have primitive tests; HAPI displayed a running source command, retrieved its output and stopped another through both the HAPI API and browser control before its side effect. Unit tests verify that completed results remain available as further tasks start. | Native tool naming and complete task semantics, browser stop on other platforms, multiple concurrent tasks through HAPI, reconnect and durable results. The prototype limits concurrent tasks to 16 and retains at most 128 task results per session; it is not a native-equivalent lifecycle. |
| Skills and instructions | A source project instruction marker and one explicitly invoked, simple project skill were verified through HAPI and the authenticated remote runtime. | Full skill syntax and scopes, dynamic discovery, hooks, source context, nested instructions, custom commands and extension lifecycle. |
| Platforms | The primitive suite passed natively on Windows (70 passed, 3 skipped) and Linux (68 passed, 5 skipped). Cross-host HAPI/Claude tests with a native Linux TLS relay, Windows controller and Windows source passed file operations, background shell output/stop, and browser-driven session creation and subagent stop without Docker or shared storage. | Full end-to-end matrix on Windows, Linux and macOS, without Docker or shared storage. Skipped cases are not passing platform evidence. |
| Production delivery | Isolated tests use temporary HAPI binaries, agents, relay and workspaces. | A production installer, persistent service management, upgrades, monitoring, rollback and validation against the user's existing HAPI and user accounts remain outstanding. |

The prototype deliberately disables or rejects unsupported controller-side tools rather than claiming they execute on the source. The SDK tool aliases expose MCP-prefixed names to hooks; the experimental project hook adapter maps the tested built-in names back before dispatch. No full-parity conclusion follows from these partial results.

With the installed Windows OMP executable supplied explicitly, tests initialized its actual ACP process directly and through the relay and created an ACP session without invoking a model. In the inspected session response, no `models.availableModels` field or model configuration category was present; mode and thought-level configuration were present. This does not establish that model selection is impossible through other OMP mechanisms. OMP's HAPI integration and the feature comparison remain unverified.

OMP 18.18.3 on Windows also answered the Pi-style RPC `get_state` and `get_available_models` commands, accepted `set_model` between two OpenAI catalog entries and registered a synthetic tool with `set_host_tools`. This used a placeholder API key, an ephemeral session and no model request. A separate isolated test used a local synthetic OpenAI-compatible model to request that host tool; the RPC host received its arguments, sent progress and a result, and observed the subsequent model response. A second invocation was aborted and produced a cancellation referencing the original host call; a third reported an error in the tool event and the subsequent model request. No external model service was used. This demonstrates the exercised RPC callbacks described in the [OMP reference](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md), not end-to-end HAPI operation, PAC model registration or complete tool/lifecycle parity.

The same installed OMP rejected Pi's `get_commands` and accepted `get_available_commands`. HAPI's Pi integration currently requests `get_commands`, so substituting the OMP executable alone does not establish command or skill discovery. The OMP RPC reference also documents other dialect differences in history, subagent events and completion; each needs translation and verification before treating the harnesses as equivalent.

A server-level test verifies two PAC names with distinct agent credentials and separate source scopes, including cross-scope denials and correct routing. This does not replace the required test with two independently authenticated Claude runtimes.

A separate HAPI test sent requests simultaneously to two named PAC sessions and verified distinct workspace results. Both names still used the same authenticated Claude account, so this is not evidence of independent controller identities or the full concurrency matrix.

Windows process cleanup uses a kernel Job Object for source shell commands and project hooks. Tests cover a Git Bash descendant and a timed-out hook descendant that would otherwise write after cancellation; the resulting processes did not perform their delayed writes. This is process-lifecycle containment, not a security sandbox or evidence of complete native task semantics.

A second Windows source host was exercised in a separate temporary HAPI installation under a test account. The combined scenario passed again after the cancellation changes: source file operations, instructions, one simple skill, project hooks, limited search, shell and background work, interactive questions including one from a subagent, a second named endpoint on the same controller, approval and denial, and archive and resume with the original context and a subsequent write and skill invocation. Repeated runs encountered startup and archive timeouts under load; passing runs used longer deadlines and keepalives on the test harness's SSH connections. Diagnostics showed that a runner-started session sometimes failed to deliver its startup notification. An experimental HAPI change retains an unconfirmed PAC startup for late recovery and retries failed notifications; a subsequent multi-session run passed. The underlying notification failure and late-recovery behavior remain unverified. This is a restricted scenario, not the complete acceptance matrix or a validation of the user's production runner.

Cancellation racing a write or background command that has already started can have an unknown outcome; it must not be interpreted as proof that no side effect occurred. Recovery of active work and all disconnect races remain unverified.

The Claude SDK removed its native `TaskOutput` tool. A real-Claude test instead retrieved a background subagent result via the PAC `TaskOutput` alias.

Instruction parity must follow the [Claude Code memory specification](https://code.claude.com/docs/en/memory#import-additional-files), including Markdown-aware imports, recursive resolution, external-import approval and on-demand scoped rules. Unit tests cover bounded recursive workspace imports, escaped spaces, code examples, cycles, unscoped project rules and path matching. A cross-host HAPI scenario supplied markers through an imported workspace file and an unscoped rule. Authenticated Claude runs through OpenCode received a matching rule after Read and after a simple foreground Bash `cat`, and received a nested `CLAUDE.md` and a separate nested path-scoped rule after reading files in their directory. A synthetic model test verified injection and a separate failure test verified that an instruction loading error stops the turn. Scoped and nested instructions are currently handled for successful Read, Write and Edit calls and literal single-file `cat`, `head` and `tail` reads, with a 262,144-character per-injection limit and conservative glob expansion bounds. An authenticated HAPI run verified a scoped rule exceeding the previous 9,000-character limit. Complex and background shell reads, subagent scope, external-import approval and full Markdown and glob parity remain unverified or unsupported.

An isolated Windows-source browser scenario also observed the scoped-rule discovery warning, retried discovery, created a PAC session and stopped a running subagent before its delayed side effect. It checked native-model visibility if any were returned, but did not record whether that condition applied. The test emitted its success result but hung during cleanup, so this is evidence for those interactions, not a clean full-run result; cleanup still needs an independently completed rerun.

Another browser scenario substituted an unavailable catalog response inside the test browser, verified that the selected PAC remained visible and Create was disabled, then restored the real catalog and created the session. This validates the interface response to a discovery change, not detection of an actual transport disconnect while the form is open.

HAPI now rechecks a selected PAC against a fresh catalog immediately before launch. Component tests cover a successful launch, a missing PAC, a failed catalog response and a transport error; the selection is preserved and no session is spawned on failure. This reduces stale-form launches but does not eliminate a disconnect after the check or prove active-session recovery.

After fixing Windows process-tree shutdown for HAPI's model-variant catalog server, that browser scenario and the subagent cancellation check completed with exit code zero, including test workspace cleanup. This verifies the exercised Windows cleanup path; other lifecycle and platform cases remain open.

An expanded non-browser HAPI run also completed with exit code zero after the relay and ACP hardening changes. It exercised source file operations and search, imported instructions and an unscoped rule, one skill, project hook outcomes, foreground and background shell, subagent updates, approval and denial, two named PAC sessions and resumption with a subsequent source write and skill call. The two PAC names still shared one authenticated Claude account; this run does not establish independent controller identities or full feature parity.

A relay test closes a PAC registration while keeping both established channel peers open and verifies that the relay closes those peers without disrupting a different PAC. Registration handling is installed before the handshake completes, and reconnect tests exercise startup and recovery; this does not establish recovery of interrupted in-flight work or complete authorization guarantees.

ACP peer tests bound incoming line length, queued notification bytes and concurrently handled request bytes. Invalid JSON or response envelopes close the connection, reject in-flight calls with an unknown outcome and do not dispatch a later request from the same input chunk. These bounds deliberately reject traffic above the configured limits and do not establish parity for large payloads.

The [OpenCode V1 server API](https://opencode.ai/v1/docs/server/) exposes an experimental tool catalog with schemas. Catalog discovery alone does not prove that arbitrary configured tools can be invoked through the same OpenCode session, or that their permissions and lifecycle can be preserved. The synthetic dynamic MCP proof above does not establish integration with OpenCode-configured MCP servers or plugin tools; these remain separate acceptance requirements.

After reauthentication, isolated cross-host tests using the project-bundled controller dependencies passed real Claude text and source-file read, approved source-file write and Bash, denied write with the original file unchanged, and preservation of conversation context after restarting OpenCode. An additional local test exercises the installed OpenCode CLI, relay, installed Claude controller and a synthetic model endpoint through a source-file read. On Windows, a shortened 8.3 temporary directory caused a Node filesystem-watcher assertion; the controller now expands existing path ancestors before initializing the SDK, and the local test passes with the original shortened path. These results do not establish production deployment or the remaining parity requirements.

An isolated authenticated Claude run also accepted a small PNG attachment through the OpenCode launcher with experimental image support enabled. This is a single attachment case; it does not verify automatic model capability discovery, larger payloads or the full range of image formats.

Authenticated Claude sessions requested a two-part question through the OpenCode question interface. One test supplied a custom text answer and multiple selected options and verified them in Claude's response. Another rejected the question and successfully sent a further message in the same session. Other question forms and disconnect races remain unverified.

A standalone relay now accepts per-PAC SHA-256 token hashes, separates source and agent roles, reloads authorization for new handshakes and requires TLS for non-loopback listening. Local tests exercise role isolation, credential rotation and refusal of a plaintext public listener. An isolated cross-host test used this relay over TLS with an authenticated Claude controller and read a source-only file through OpenCode. A deployed relay, operational provisioning and rotation of existing active connections remain unverified.

An isolated patched HAPI hub and runner used the HAPI OpenCode command with the standalone TLS relay and project-bundled authenticated Claude controller. The runner offered the PAC model before creation, created the selected session and showed Read, Write and Edit operations that produced the expected source-file contents. A separate run built from the current HAPI integration branch checked the project-rule warning and created the PAC session through the browser before repeating those file operations. Both tests completed with exit code zero. This was an isolated installation on one source host; the existing production hub and both required source machines remain to be checked.

After adding file-scoped rules, another isolated browser run repeated PAC selection and source-file operations and confirmed that Claude received the matching rule after the read. This does not establish full nested and subagent instruction behavior.

An isolated HAPI run then loaded the same file-scoped rule independently for the main Claude conversation and a background subagent, and observed the marker in subsequent output. Other nested and concurrent subagent instruction cases remain unverified.

An authenticated OpenCode CLI run started a background Claude subagent, received subagent and background task events and returned the source-file result. Events are rendered as text; updates received between turns are buffered until the next turn. Native task cards, controls and complete idle-event and recovery behavior remain unverified or unsupported.

The installed OpenCode CLI also expanded `/pac-stop` in an existing session and delivered it without a model call; an independent ACP relay test routed the task identity to a synthetic controller, while rejecting a different task identity. Live Claude cancellation through this OpenCode command, native task cards and complete lifecycle handling remain unverified.

In an isolated authenticated Claude run, a background subagent started its shell command, but an OpenCode stop command submitted while the originating response was active timed out after 45 seconds. This scenario did not confirm cancellation and requires an independent control path.

An authenticated cross-host OpenCode test read a file using a relative workspace path. Local tests also verified relative writes and rejection of an attempted parent-directory escape.


## Existing HAPI deployment, 2026-11-11

The first Windows machine and its existing HAPI hub expose PAC models through the OpenCode model selector. A persistent controller and TLS relay were used by a real Claude session; no additional HAPI machine or hub is required for the user workflow. The user's existing session was resumed with the same identity and history, and read a source file beneath a combined 23,178 characters of nested instructions after the source limit was raised. The previous 9,000-character limit caused the reported instruction-loading failure.

An isolated hub on the same source machine and persistent controller verified an interactive two-question form with custom and multiple-choice answers, rejection and abort. A separately built HAPI candidate verified background command output, task visibility and cancellation via both the API and the browser, plus background subagent execution and task snapshots. The task controls require the corresponding HAPI hub, web and runner release; successful isolated verification alone does not prove that release has been deployed.

The earlier prototype-era production-delivery entry above predates this deployment. Remaining gaps include full platform and feature parity, multiple independent PAC accounts and controllers, interrupted-operation recovery, and unattended startup across an operating-system restart.

The task-control hub and web release was deployed to the existing first hub (SMA release commit `1708803`), and the matching Windows runner was installed on the first Windows machine. A real PAC answer through that hub confirmed the source working directory. The existing user session was resumed with its original identity and history; an interactive question was delivered and answered successfully there. The Windows runner was subsequently updated to use a bounded asynchronous process-identity snapshot at startup (`3fe9ea88`).

The current Claude SDK documents its former native `TaskOutput` tool as removed. A forced request for that exact tool could not succeed, even when explicitly permitted. Normal background subagent execution and delivery of its answer were verified. The PAC `TaskOutput` alias also retrieves the subagent output, with live in-memory retention and recovery from the owning session?s SDK transcript.

A later real-Claude HAPI run verified the PAC task-output alias together with project instructions, scoped rules, an invoked skill, a successful post-tool hook, a hook denial, a failed hook blocking the operation, and a tool-failure hook. A separate run verified interactive answers, rejection and abort, a question from a child agent, two parallel subagents and task-output retrieval in one session. These are scenario-specific results; live task-output buffers are bounded; a separate real-Claude test retrieved the subagent result again after archiving and resuming the same HAPI session.

A subsequent real-Claude HAPI test explicitly archived and resumed the same session, then retrieved the earlier subagent result through PAC `TaskOutput` from the SDK transcript. Recovery checks that the subagent ID belongs to the requested session before loading its messages. Recovery depends on the SDK retaining that transcript.

## Provider skill checks, 2026-11-12

The installed OpenCode 1.19.5 listed 18 file-backed skills and one built-in skill in the first machine's SaaS workspace. The bridge loaded all 18 file-backed entries; real-Claude provider tests independently recorded calls to a nested global `docx` skill and the built-in `customize-opencode` skill. The built-in is returned as content without adding a filesystem resource root. See [built-in skill support](https://github.com/3ndetz/pac-bridge/commit/f9c90d4).

An isolated project comparison exposed a missing ancestor search: native OpenCode found a parent skill while the bridge did not. A nested Git repository excluded a skill outside its boundary, and a nearer duplicate took precedence. After [the fix](https://github.com/3ndetz/pac-bridge/commit/12359bf), automated tests covered those cases and a real-Claude provider test recorded invocation of a skill from a parent directory. These tests do not establish full OpenCode plugin, permission, metadata or skill parity.

Provider version `f9c90d4` was staged and selected on both profiles, but a later audit found that the running machine 4 runner still used a different fixed wrapper, `32681b3`; an earlier migration had changed wrapper `2b78f7c` instead. Its previously successful real-Claude, compaction and recall tests therefore exercised the older code, not `f9c90d4`. The actual wrapper has now been switched to the current provider pointer without restarting conversations; validation of the newly selected version is recorded separately in Jira. The first machine's existing runner did use the selected provider version in its real-Claude, compaction and recall check. Automatic compaction at the actual model limit, all capabilities after resume, and non-Windows installations remain open in [the checklist](RELIABILITY-CHECKLIST.md).

After correcting the machine 4 wrapper, the running provider version `058d7cb` was checked through its existing HAPI: a real Claude turn invoked `customize-opencode`, manual compaction completed, and the next turn recalled a marker. The same version answered and retained a marker after manual compaction on the first machine. Both runners' model-list requests used the requested test directory: PAC models appeared for an allowed directory and were absent for a directory containing an unsupported deny rule. Native OpenCode models remained visible on machine 4. A user-profile Telegram sender recorded successful deliveries on both machines. These observations cover the named scenarios, not all hook events or every skill.

A separate real-Claude test on the first machine invoked a project skill and read its resource; matching project `PreToolUse` and `PostToolUse` hooks for both `Skill` and `Read` were observed before and after manual compaction, and a remembered marker survived compaction. The first version of the test hook had invalid JavaScript and could not establish whether hooks worked; the fixture was corrected and independently syntax-checked before the successful observations. After archiving and resuming this same session, the first prompt failed with a server connection reset. A subsequent prompt was blocked because the previous turn's outcome was uncertain. That attempt did not establish successful recovery; the subsequent diagnosis and retest are recorded below. Global Claude hooks and OpenCode plugins were not covered by this test.

Diagnostics identified a historical `compaction_update` notification during ACP session loading. The provider treated it as an unexpected update outside a turn and disconnected. After [the fix](https://github.com/3ndetz/pac-bridge/commit/5b8ff08), the previously failing test sessions on both Windows machines were resumed with their original identities. On each, Claude invoked the same skill, read its resource, recalled the marker from before compaction, and produced four further matching hook events. Both test chats were confirmed archived afterwards. Other hook and subagent cases remain separate checks. One machine 4 attempt took approximately 168 seconds to initialize ACP; the startup delay remains to be investigated.

For comparison, subsequent machine 4 logs showed about 82 seconds for a new session to initialize ACP and about 16 and 20 seconds for two resumed-session initializations. These observations confirm variable startup latency, not its cause or a guaranteed upper bound.

The POSIX source installer was run twice in a disposable Linux Node 24 environment using a committed Git checkout, synthetic connection files and a synthetic native OpenCode executable. Both installations succeeded, the launcher forwarded `--version` to the native executable, and the launcher tests passed. A separate test used the installed launcher and real Linux OpenCode 1.19.5 with a synthetic TLS PAC controller: PAC selection and its reply worked, and native models remained available after the synthetic PAC token was removed. The test container was removed afterwards. This does not verify a real authenticated PAC connection, HAPI runner integration, startup after reboot, or macOS.

On both Windows machines, real-Claude tests interrupted isolated HAPI sessions after a Bash command appended exactly one line and before its delayed completion. In each case the pending marker survived. After reviewing this synthetic action and archiving the chat, the [reconciliation command](docs/recovery.md) cleared the marker, the original chat resumed and recalled a prior fact, and the file still contained exactly one line. Both test chats were confirmed archived afterwards. The scenario passed on both machines with versions `9aeab8e`, `20ab292` and `5118298`. This verifies the named interruption and reviewed recovery scenario, not every remote side effect or background-task failure. Automated concurrency and stale recovery-lock tests also passed on Windows and Linux.

With version `4cf46b9`, a normal workspace on each Windows machine exposed PAC models, while a workspace containing an unsupported OpenCode plugin excluded PAC and retained 12 native models on the first machine and 14 on machine 4 after native OpenCode had warmed up. That discovery filter was subsequently removed to preserve the requirement that available PAC models appear in the selector. A PAC turn with an unsupported plugin still stops explicitly rather than silently skipping the plugin. An earlier cold native initialization took about 35 seconds and exceeded HAPI's 30-second model-probe limit; increasing the bridge's bounded native budget cannot remove that upstream limit. Listing a PAC model does not establish plugin compatibility.

After removing the discovery filter, the existing HAPI on the first machine listed 13 PAC and 12 native models in that test project; machine 4 listed 13 PAC and 14 native models. A separate test chat on each machine selected PAC and displayed the explicit unsupported-plugin explanation; both were archived afterwards. This does not mean the plugin itself was applied.

After correcting mixed-family model labels, each existing Windows HAPI listed `PAC #1 / Claude Opus 5.5` and `PAC #1 / Claude Sonnet 5.5` from the real PAC. A separate test with actual OpenCode and a synthetic mixed-family PAC selected both Sonnet and a provider-qualified Codex model, received their respective responses, and verified Codex was not labelled Claude. The real PAC tested here did not expose a Codex model.

Before the later mixed-family model-label change, the Windows `test/*.test.mjs` suite completed with 162 passing tests and 18 explicitly skipped environment-dependent tests. The label change was checked separately with unit tests and actual OpenCode against a synthetic mixed-family controller. An initial broad `node --test` invocation also selected non-test live fixtures and was stopped; those fixture errors are not results of the scoped suite. The separately documented live checks above do not turn the skipped scenarios into passed tests.

The opt-in [skill, hook and recovery fixture](test/fixtures/hapi-skill-hooks-recovery.mjs) creates a separate real HAPI chat and consumes model quota. On the source machine, set `PAC_TEST_INSTALLED=1`; optionally set `PAC_TEST_HAPI_HOME` to the existing HAPI profile directory, `PAC_TEST_MODEL` to an available PAC model ID and `PAC_TEST_TIMEOUT_MS` to a longer per-stage wait, then run `node test/fixtures/hapi-skill-hooks-recovery.mjs`. It archives the test chat on completion and leaves its synthetic project under `~/sma-test` for inspection. Do not run it as part of the default unit test suite.

On Linux, the installed POSIX launcher connected to the real PAC through ACP, discovered the selected model and received a response. The same paid check invoked a project skill, read its resource, and observed project pre-tool and post-tool hooks for both Skill and Read. Dependencies were installed before the actual connection files were mounted. This does not establish integration with an existing Linux HAPI instance or macOS. A Windows synthetic OpenCode test for retaining the same PAC conversation across messages also passed when repeated in isolation after an earlier timeout; cold startup latency remains open.

A subsequent Windows suite exposed a cleanup race: the model probe sent a termination request but returned before the child released its working directory. The probe now waits up to one second for process closure within the HAPI timeout budget. The affected test passed five consecutive runs and the scoped Windows suite then completed with 163 passes and 18 environment-dependent skips. This does not establish that cold native OpenCode always starts within HAPI's timeout.

OpenCode V1 skill metadata is accepted as a string-to-string map in [this change](https://github.com/3ndetz/pac-bridge/commit/870561c). Unit tests cover metadata and reject unsupported nested values. Through the existing first-machine HAPI, real Claude invoked a metadata-bearing skill and read its resource before and after compaction, then resumed the original archived chat and invoked it again. Four matching project hook events were recorded at each stage and the remembered marker survived. This confirms that particular metadata and hook scenario, not all skill metadata or plugin semantics.

The same metadata-bearing skill, resource, project hook, compaction and same-chat resume scenario also passed with real Claude through the existing machine 4 HAPI: four hook events were observed at each of the three stages, the remembered marker survived, and the disposable chat was archived. The first stage was slow to start; this does not resolve the cold-start investigation.

The [ACP working-directory fix](https://github.com/3ndetz/pac-bridge/commit/f320458) uses `--cwd` for PAC discovery and normalizes a relative argument before spawning OpenCode. In a real OpenCode test with a synthetic PAC, the inherited process directory contained a deny rule while the requested project did not; model discovery and responses succeeded for the requested project. After installation, a real HAPI first-turn check on machine 4 still took about 106 seconds, so the slow-start issue remains open and its cause is not established.

In the first machine's current bridge checkout, direct source-skill discovery found 18 file-backed project and user skills, and loading each one's instructions succeeded. This is a read-only loading check; it does not establish that a model can apply every skill correctly or that its external dependencies work.


On 13 November, a real Claude background shell task in the existing first-machine HAPI was stopped with `/pac-stop <task-id>`. The same isolated chat reported the stop and its scheduled write was absent after the command would have completed. The chat was confirmed archived. This supersedes the earlier synthetic-only stop result above; it does not establish native task cards or every cancellation and recovery scenario.


After the PAC account was signed in again on 13 November, real Claude passed the skill resource, project hook, manual compaction and same-session resume scenario through both existing Windows HAPI instances. Four matching hook events were observed in each of the three stages on each machine. The first machine reported an uncertain final archive response; a separate read confirmed that the test chat was archived. The first response remained slow, and the checks do not establish general OpenCode plugin or hook parity.


The unmodified PAC-free HAPI web selector from source commit `2161a9f` was rendered in a component test with PAC Claude, PAC Codex and native models. Their labels appeared and both PAC IDs were returned unchanged when selected. Re-run with Docker using `node scripts/verify-stock-hapi-selector.mjs <absolute-saas-apps-center-checkout>` on the branch whose web recipe pins that source. This is not an end-to-end verification of the live HAPI, provider discovery, warnings, or existing sessions.

## Provider shutdown and concurrent compaction (2026-11-17)

Two regressions were reproduced before correction: HTTP shutdown did not abort an active turn until its connection closed, and concurrent compaction requests could both invoke the remote operation. Provider shutdown now aborts its turns before closing its own HTTP connections. Compaction reserves the session before awaiting the router; a concurrent request receives 409.

The scoped Windows run of `test/provider-shutdown.test.mjs` and `test/opencode-provider.test.mjs` passed all 31 cases using synthetic loopback services, without installed profiles or model calls. This establishes provider-level behavior, not production HAPI process-tree cleanup or archive acknowledgement.

## Router shutdown races (2026-11-17)

Four router shutdown failures were reproduced with controlled asynchronous reads and opens: shutdown during journal read or store read could still launch ACP, an existing opening received no cancellation signal, and one session-close exception skipped other sessions. The router now rechecks closure before opening, propagates a lifetime AbortSignal, and attempts every owned session cleanup while retaining failed sessions for owner retry. The launcher closes HTTP even if router cleanup reports an error.

Cancellation of a stalled initialize also reproduced a redundant Windows child-handle kill: the first accepted request was followed by a second request before the exit event, which could return false. Accepted stop requests are now idempotent for the same retained child object; a refused first request still throws and can be retried. Acceptance of a stop remains distinct from exit confirmation. This reproduces one concrete failure path; it does not establish the cause of every earlier job-host failure.

All 24 focused Windows checks passed, including real contained-process initialize cancellation, pre-cancellation, pending approval, unfinished HTTP body, router races and synthetic owned-handle stop responses. Full platform runs and installed HAPI shutdown acceptance remain required.

## Model-probe cleanup and host cache (2026-11-17)

The Linux scoped run at the shutdown integration passed 315 cases with 66 skips. The first Windows full run passed 341 with 38 skips and two failures: its allowlisted PATH omitted ripgrep, and a synthetic model-probe directory remained busy. The test-owned outer Job Object confirmed zero remaining active processes before its temporary root was removed.

The native model probe previously ignored a failed stop and treated its one-second cleanup timeout as success. It now requires owned-child exit evidence and reports an unconfirmed exit instead of silently continuing. Twelve focused Windows checks passed, including the real synthetic probe and a minimal-environment job-host invocation. Test-directory removal retries transient Windows file locks only within the already verified disposable root.

Minimal-environment PowerShell hosting could create ModuleAnalysisCache under the working directory. The host now defaults PSModuleAnalysisCachePath to NUL when the caller did not supply it, as documented in [Microsoft's Windows PowerShell environment guidance](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_windows_powershell_5.1). A real Windows contained-child check confirmed the expected variable and an empty disposable workspace. An explicitly provided cache setting remains unchanged.

## Exact Windows snapshot and cancellation during opening (2026-11-17)

A git archive of `56e2e91d550eb916991c0137fd65bb7a17045433` passed the complete Windows scoped suite: 384 tests, 346 passed, 38 skipped, zero failures. The archive ran under a disposable HOME containing TEMP, with an allowlisted environment, explicit Git Bash and ripgrep, and no inherited provider credentials. The outer owned Job Object reported zero active processes before the temporary snapshot and profile were removed. Development dependencies were reused; this was not a clean dependency installation or installed-runtime acceptance.

A subsequent cancellation audit reproduced remote opening after a user cancelled while journal or binding reads were pending. User-turn cancellation now reaches the lifetime signal of an in-flight ACP opening, and cancellation observed before opening prevents the spawn. All 21 focused Windows session-router, shutdown and ACP cancellation cases passed. Cancellation cannot establish whether a remote session was created before interruption, so uncertain opening remains non-retryable.

The owner deferred macOS acceptance on this date; current platform acceptance targets Windows and Linux.

## Controller child ownership after disconnect (2026-11-17)

The controller transport removed a session when its WebSocket closed, even if stopping its child failed or the child had not exited; shutdown also cleared the complete ownership set unconditionally. It now retains the child and its max-session capacity until the child's close event. Repeated owner shutdown can retry a refused stop. Diagnostic callback failures cannot interrupt cleanup of other owned children. Local spawn/stop dependencies are injectable for deterministic tests; they are never obtained from relay requests.

Three synthetic loopback regressions passed on Windows: admission remains blocked until owned-child closure, refused stops remain available to the owner for retry, and diagnostic failures do not skip another child. The existing relay run also passed its 14 applicable scenarios, including real contained-child disconnect and descendant termination; the real OMP opt-in was skipped. These checks do not establish production parent-exit or restart cleanup.

The exact `56e2e91` Linux archive passed all 384 scoped cases: 317 passed, 67 skipped, zero failures, with network disabled and development dependencies mounted read-only. The audit image's inherited OPENCODE_CONFIG override was explicitly cleared for this synthetic run. Earlier snapshot attempts with that override produced eight configuration-policy rejections and are not counted as passing evidence.

## Supervisor generation drain (2026-11-17)

Controller registration reconnection now waits for the previous owner's registration closure and child close events. The supervisor retains owners until their closed promise resolves, so shutdown can still retry cleanup after transport loss. A new synthetic test holds an old child open across several retry intervals: no second registration is admitted until that exact child emits close.

The combined Windows relay and owner-lifecycle run passed 18 cases with one explicit real-OMP skip and no failures. This includes the existing real descendant-stop check. Process close evidence is not a replacement for platform-level job accounting or installed-runtime acceptance.

## Full controller-lifecycle snapshot (2026-11-17)

The exact `54be4f0e862239f33ead07c0a69a047d934acced` archive passed the full scoped suites on both platforms. Windows: 391 tests, 353 passed, 38 skipped, zero failures; the test-owned Job Object confirmed zero active processes and its disposable profile and snapshot were removed. Linux: 391 tests, 324 passed, 67 skipped, zero failures, using an offline container and read-only development dependencies. Neither run used installed profiles or paid model calls.

## POSIX installer commit identity (2026-11-17)

A synthetic real-Git regression reproduced staging a second commit under the first commit's revision when HEAD moved just before archive creation. The installer now archives the already selected full SHA. Additional preflight checks require the source to be its own checkout root, reject uncommitted provider source and require committed provider/dependency entrypoints before creating installation directories. These changes do not establish pathname-race safety, crash recovery or production installation acceptance.

## Awaitable controller shutdown and POSIX interruption checks (2026-11-17)

The controller CLI no longer calls process.exit immediately after requesting shutdown. It waits for the agent's owned-close result. Supervised shutdown now waits for pending connection attempts, including credential reads, and then drains any owner obtained by those attempts. A diagnostic callback cannot prevent reconnect scheduling. The combined Windows relay/lifecycle run passed 20 cases, with one explicit real-OMP skip and zero failures; CLI syntax validation also passed. This does not establish Windows service-manager signal delivery.

The POSIX commit-identity and preflight suite passed four cases against synthetic real Git repositories. Existing temp-file/hard-link preservation checks and owned pidfd SIGTERM and SIGKILL checks also passed in offline Linux containers. SIGTERM cleaned its stage and lock; SIGKILL retained them, and a retry refused that unresolved state. Shell checks used an LF archive produced with core.autocrlf=false, avoiding Windows export filters. Automatic SIGKILL recovery remains open.

## Linux command-tree ownership (2026-11-17)

The Linux contained-command path now uses a Python subreaper and retained pidfds instead of numeric process-group termination. Explicit stop and parent-loss detection use a separate owner pipe that the command does not inherit. Command completion also drains adopted descendants, including detached children. Standard stdin, stdout EOF and exit status remain observable independently of the owner control protocol.

Successful tree cleanup requires a nonce-bound acknowledgement after waitpid reports no remaining owned children, followed by host close. A missing acknowledgement is not accepted as cleanup. Controller child capacity remains reserved on an unconfirmed tree exit. Synthetic MCP transport cleanup also waits for this ownership result; real configuration provenance discovery remains disabled.

The related offline Linux run passed 33 focused cases. A full read-only working-tree run then passed 405 cases: 338 passed, 67 skipped, zero failures; SHA-256 checks confirmed source files did not change during that run. A later targeted regression reproduced a false unconfirmed result between exit and close. That race was corrected; the final 14-case owner/installer run passed, including cancellation before bootstrap, detached descendants, separate owner isolation, preserved stdout EOF, exit/close ordering, bad-host refusal and the installer's explicit ownership capability response. Full committed-snapshot verification follows this change.

A preliminary integration run timed out on stdout EOF before the host released its own stdout descriptor. That test-owned container was stopped after its exact command, read-only mount and creation time were verified. Subsequent isolated runs passed. No production profile or real PAC configuration was activated by these checks. See [process ownership](docs/process-ownership.md) for runtime prerequisites and boundaries.

## Committed Linux-owner snapshot and relay identity groundwork (2026-11-17)

Exact snapshot `fabe04dd5e3e63b6ec7d8c13681c0f088a80a5a8` passed all 407 scoped cases on both platforms. Windows: 355 passed, 52 skipped, zero failures, with zero active processes confirmed by the test-owned Job Object. Linux: 340 passed, 67 skipped, zero failures, using an offline container and read-only dependencies. Neither run activated an installed profile or used paid models.

The relay now derives a source principal from authenticated credentials and sends it in its controller registration message. Spoofed source headers are ignored. Optional `sourceIds` maps authorized credential hashes to stable operator-chosen IDs for rotation; the PAC name scopes every identity. Without an explicit mapping, rotating a source credential changes its principal. This is identity groundwork only: controller session ownership enforcement and migration are still outstanding, and existing installations were not changed.

## Controller session ownership (2026-11-17)

The controller now persists write-once ownership for newly created and forked sessions and verifies the relay-authenticated principal before SDK load, resume, prompt, cancellation, close, delete, steering, goals and configuration/task operations. Lists exclude other-owned and legacy-unbound sessions. Identity override options are rejected. Resume now passes through PAC source-tool preparation as load already did. Custom hook and task extensions also verify ownership. Missing relay identity prevents controller creation; source-controlled headers, metadata and inherited principal environment variants cannot replace it.

Focused Windows and offline Linux checks passed after correcting the ACP error type: the SDK previously converted the intended denial into generic Internal error. Additional Windows checks passed for a linked ownership directory and cleanup after a failed new-session binding. An optional offline synthetic-model run could not create a Linux SDK session because host dependencies contain only the Windows native SDK binary; it failed explicitly before model requests, rather than establishing model-backed acceptance.

No installed configuration was migrated. Legacy ownership migration, Windows profile ACL acceptance, local shared-provider caller isolation and installed two-machine acceptance remain open. Details and credential-rotation semantics are in [session authorization](docs/session-authorization.md).

## Saved session-ownership snapshot and reviewed migration (2026-11-17)

Exact `48e3ee105b30d297493991a76543571f110d7371` passed all 423 scoped cases. Windows: 371 passed, 52 skipped, zero failures, with test-owned Job Object drain confirmed and its disposable profile removed. Linux: 356 passed, 67 skipped, zero failures, in an offline container. A separate sanitized Windows snapshot run passed all three controller cases, including the local synthetic model response; no paid endpoint or installed user configuration was used.

The operator-only legacy migration command passed five focused cases on both Windows and offline Linux. Planning does not create the ownership directory or print private session IDs/principals. Application requires a fingerprint bound to the reviewed mapping and target. Duplicate or unreviewed entries, changed plans and existing conflicting owners are rejected; matching claims can be resumed idempotently. Live legacy migration has not been performed. The update guide now explains why git pull alone is insufficient and records relay/controller ordering, preserved backups, staged-provider activation and rollback limitations.

## Windows job ownership acknowledgement (2026-11-17)

Windows contained commands now use a separate random named pipe and per-launch nonce. The command starts suspended inside the retained Job Object after an execution grant; an early stop prevents execution. Stop and parent loss request termination through that private channel. Normal command completion also drains remaining descendants. The host queries ActiveProcesses until zero before acknowledging, and Node requires the exact nonce-bound protocol plus host close. Missing proof preserves an unconfirmed result. The controller waits for this separate ownership promise before releasing a session slot. The default confirmation deadline now accommodates host startup and bounded job accounting.

Six focused Windows cases passed for stdin/exit status, detached descendants, bootstrap cancellation, independent owners, missing proof after host kill and actual parent loss with known command/descendant loopback connections. A separate delayed-proof controller regression passed. Related Linux lifecycle/source-identity checks passed 14 cases with three Windows-only skips. Existing relay checks, including real owned descendant shutdown, also passed. Installed service-manager and production acceptance remain outstanding.

An early stdout EOF experiment failed both through the wrapper and directly without PAC, so the attempted separate stdout implementation and its nonportable fixture were removed. Early EOF remains unconfirmed and is not represented as fixed. One timed-out test command was interrupted through its own retained exec session; no global process scan or process-name termination was used.

## Ownership proof at source operation completion (2026-11-17)

Full `39d8a50234e3471f6958aed959d6a9ef6c1737c1` Linux verification passed 435 cases: 362 passed, 73 skipped, zero failures. The corresponding Windows run had 382 passes, 52 skips and one failure: a 150 ms synthetic native-probe cancellation outlasted its fixed one-second cleanup allowance while the Windows host bootstrapped. Its enclosing test Job Object confirmed drain and its disposable root was removed. This run is not recorded as a full Windows pass.

Native-probe cleanup now uses the remaining overall 30-second HAPI budget, capped at 20 seconds, and still refuses unconfirmed cleanup. Cold host startup and shared RPC timing are tested separately, so compilation time does not masquerade as a failed per-request budget. Windows wildcard executable patterns without a matching literal file are rejected before creating the owner host.

Terminal completion, project hooks and built-in skill discovery now wait for the separate ownership proof after host close. An exit-zero result with missing proof fails explicitly. Unconfirmed terminal ownership retains its slot. Async hook shutdown is awaitable and retains ownership failures instead of discarding them as ordinary hook errors; the next drain fails closed, and source disconnect retains the cleanup result. Trusted local spawn injection is used only by isolated tests, never by remote ACP parameters.

The focused final probe/ownership/queue run passed 15 Windows cases. A preceding Linux terminal/async/probe run passed 24 cases with one Windows-only skip. Real Windows terminal and hook checks passed apart from the cold-probe expectation subsequently separated and the wildcard case subsequently moved before spawn. Final committed-snapshot verification follows these fixes. No installed runtime or real source MCP/plugin provenance route was activated.

## Committed source-completion snapshot and Windows immutable staging (2026-11-17)

Exact `00c61d675949d928adc802382c7e33b2410df606` passed the full scoped suites on both platforms. Windows: 442 cases, 390 passed, 52 skipped, zero failures; the enclosing test Job Object confirmed zero active processes and the disposable profile was removed. Linux: 442 cases, 369 passed, 73 skipped, zero failures, using an offline container and read-only dependencies. This confirms the previous Windows probe failure was resolved in the saved snapshot.

Windows provider staging now exports the selected full Git SHA with LF export filters instead of copying mutable checkout files after recording HEAD. Dependency manifests come from that same archive. The exporter validates Git entry modes, Windows path names, case-colliding parent directories, exact archive membership, size bounds and an initially empty destination; extraction uses create-new files. Checkout preflight also rejects changed installer scripts. These checks do not establish full pathname-race safety or transactional activation/rollback.

Five focused real-Git Windows cases passed: moved HEAD plus dirty source still exported the selected revision, Unicode/LF content was preserved, a nonempty destination retained its sentinel, and symlinks, case collisions and reserved device paths were rejected before files were written. Reserved paths were supplied as Git metadata without materializing device files or disabling Git NTFS protections. The existing ZIP/nested/modified/incomplete checkout preflight also passed, including a modified installer source. Installed-runtime installation/update acceptance remains outstanding.

## Complete synthetic Windows provider installation (2026-11-17)

Saved revision `615387fa77e761d5a0d411575aa3bf6f6f93a862` passed the complete provider installer probe for both modern and legacy connection layouts, each in a separate disposable profile with synthetic connection files. The probe installed 101 locked source-only packages, staged without activation, selected the provider, verified named-provider/migration settings and the immutable dispatch wrapper, repeated activation without duplicating the runtime loader, then disabled it while preserving the original runtime content. Controller-only Anthropic dependencies were absent from the source installation.

Each run's enclosing test-owned Job Object confirmed zero active processes; both disposable profiles, staged packages and snapshots were removed. Completed synthetic/installer driver scripts were also removed; private verification logs were retained as evidence. No HAPI runner, real PAC connection, existing profile or active chat was started or changed. This covers the tested synthetic layouts, not crash recovery, transactional rollback, pathname attacks or installed two-machine acceptance.

A fresh Git fetch confirmed main and origin/main matched with zero ahead/behind, no stashes, no unmerged local branches and a single worktree. Remaining delivery work is maintained in [the completion worklist](docs/completion-worklist.md).


## Windows private Stop transcript groundwork (2026-11-17)

Windows now has a bounded handle-based private snapshot and ephemeral callback transcript path. Focused checks passed eight cases with one Linux-only skip, including concurrent writer rejection, keeper write/rename rejection, token-default ownership, ACLs, links, callback failure and parent loss with test Job drain. A separate private-profile fake-model controller run passed all three cases, including Stop block/continue and resumed history. Its owned Job reached zero processes and its disposable profile was removed. The synthetic lifecycle flag remains required; installed global Stop hooks are not enabled.

Saved `74d32ae30478504faa9bd983cecef3b7bd909c5e` passed the full offline Linux suite: 454 cases, 369 passed, 85 skipped, zero failures. Its concurrent Windows run did not pass: 397 passed, one failed, four cancelled on deadlines and 52 skipped. The enclosing Windows Job confirmed zero active processes and its disposable root was removed. Four cancelled cases hit existing timing limits. The failed nonce fixture exposed a file-replacement race in the test owner: a signal could disappear between existence and read checks. The fixture now treats only missing-file/directory exceptions as an absent signal; other errors remain failures. Focused retry and a separate Windows run are required before claiming full Windows verification of this change.

The synthetic SDK root is provisioned with a protected user-only ACL before history creation. Earlier probes correctly rejected its broadly inherited temporary profile; snapshot checks were retained. Windows token-default ownership is accepted for snapshots in addition to the current user, with the same restricted ACL grants. Keeper ownership remains explicitly user-only. Initial diagnostic failures and startup deadlines are not evidence of installed-runtime acceptance. No real PAC profile, HAPI runner or active chat was switched.


## Saved Windows retry after signal-race correction (2026-11-17)

The five previously failing/cancelled suites passed all 31 focused cases after the fixture correction, with owned Job drain and disposable profile removal confirmed. Saved `50e069fc5f732fa1100610e28464c0819564d949` then passed the complete Windows suite without a concurrent Linux suite: 454 cases, 402 passed, 52 skipped, zero failures and zero cancellations, in 173 seconds. Its enclosing Job confirmed zero active processes and the disposable profile was removed. The prior failed full run remains recorded above.

Linux runtime code is unchanged from the fully verified `74d32ae30478504faa9bd983cecef3b7bd909c5e` snapshot; the intervening change contains only the Windows test fixture and documentation. The independent fake-model Stop scenario also remains a separate three-case pass, not installed HAPI acceptance. Supported global-hook discovery documentation was corrected to match the current implementation; unsupported preferences, proxy settings and the lifecycle gate remain explicit. All remaining delivery requirements are retained in [the completion worklist](docs/completion-worklist.md).


## Source harness correction: OpenCode, not local Claude (2026-11-17)

The source requirement has been clarified explicitly: OpenCode skills, rules, configuration, permissions and plugins belong to the source machine. Local Claude Code is not a prerequisite. Previous local Claude hook/transcript checks are isolated experiment evidence and do not count as native OpenCode plugin acceptance.

The router and direct catalogue discovery no longer instantiate local Claude hooks, inspect their settings/proxies, or forward their model preferences. The OpenCode adapter now uses a dedicated instruction reader for project/global OpenCode AGENTS files and nearby nested AGENTS files; it does not expand Claude imports, local Claude instruction files or path-scoped rules. Skills use OpenCode/agents roots, XDG/config-dir settings and project-config disabling. Implicit local Claude skills are excluded. Source child processes disable Claude compatibility without editing any profile file. PAC-side Claude authentication and network configuration are unchanged.

Synthetic regressions verify that malformed local Claude settings, a local Claude proxy and private instruction/skill canaries neither block catalogue/prompt handling nor reach the PAC. OpenCode rules and skill metadata do reach the fake PAC. Unsolicited Claude hook execution is rejected. Changing local Claude settings during an OpenCode session has no effect, while unsupported native OpenCode permission/plugin configuration still stops the turn. Historical opt-in Stop/async integration files are retained with negative source-isolation assertions; no integration coverage file was deleted.

Focused Windows source-boundary, precedence, skills and router checks passed before the full saved-snapshot run. Full Windows/Linux results will be recorded separately. Real source MCP/plugin provenance discovery remains disabled. This corrects the source-harness dependency; it does not establish complete native OpenCode plugin support or installed two-machine acceptance.


## Saved OpenCode source-boundary verification (2026-11-17)

Exact `95c5ff72dcb7220d570bc7c3d84f648aa1f6e95b` passed the full scoped suites on both platforms. Windows: 461 cases, 408 passed, 53 skipped, zero failures/cancellations, in 177 seconds. The outer owned Job confirmed zero active processes and its disposable profile was removed. Linux: 461 cases, 376 passed, 85 skipped, zero failures/cancellations, in an offline container with read-only dependencies, in 85 seconds.

Both suites include OpenCode-only instruction/skill discovery, local Claude canary exclusion, direct catalogue discovery and rejection of unsupported native OpenCode permissions/plugins. Native source MCP/plugin provenance discovery stayed disabled. No paid model calls or installed HAPI/PAC activation were performed. The retained Linux opt-in real-SDK async/Stop isolation scenarios were skipped in these scoped runs; their presence is not recorded as a pass. The previous controller transcript experiments remain separate from native OpenCode plugin acceptance.

### Revision-bound transport handoff, 17 November 2026

The optional single-PAC HAPI deployment relay is now bound to the selected immutable
provider revision. New source processes can use a separately prepared relay/controller
generation while existing processes retain their inherited endpoint. The Windows
selector constructor preserves that endpoint when advancing the provider revision.

Windows focused source/provider regressions: 27 cases, 26 passed, 1 platform skip,
0 failures or cancellations. This includes OpenCode source isolation, replay and
subagent event attribution, provider dispatch, transport TLS/revision boundaries and
actual PowerShell selector construction. Linux offline transport/dispatch checks:
3 passed, 1 Windows-only skip, 0 failures. No model calls or real source MCP/plugin
provenance discovery were performed. These checks do not establish installed handoff
acceptance, which must be recorded separately after deployment.

### Installed generation handoff, 17 November 2026

Both existing Windows source profiles now select provider revision
`11f012bfce0c63a17877a0b1cb037184bb8eb788`. All 82 adapter/source files were
compared with the published revision on each profile. Selected-code read-back
confirmed the new TLS relay endpoint in each new process environment. Existing
runner identities and profile ACLs were preserved; no runner restart was used.
The eight previously active OpenCode sessions on the first hub and the one on the
second hub remained active after selection.

A separate relay/controller generation runs revision
`33200a9a290d22e21edc71921bb41b4744a927d4`. Its TLS and authenticated ACP
initialize passed without creating a session, invoking a model or discovering
source MCP/plugins. The previous generation retains its five established
connections. Its authorization now refuses new source handshakes with HTTP 401;
the new generation has a separate authorization file and accepts the same reviewed
source identities. Existing legacy channels were not restarted.

The reviewed legacy ownership migration contains 150 sessions from two distinct
source identities. Read-back found all 150 bound and none pending. Checks against
the actual controller ownership store accepted all 150 intended owners and denied
the other existing source identity for all 150 records. This is metadata-level
authorization evidence, not a claim that 150 model conversations were replayed.

This establishes selected source versions, migration, transport initialization and
preserved active-session state. Installed model turns, tools, permissions,
compaction/recall, migrated-session resume, crash recovery and the complete native
OpenCode feature matrix remain separate acceptance work. macOS remains deferred.


### Real ACP model, resume and compaction acceptance, 17 November 2026

A dedicated empty workspace and an exclusively created PAC session were used on
selected source revision `11f012bfce0c63a17877a0b1cb037184bb8eb788` and controller
revision `33200a9a290d22e21edc71921bb41b4744a927d4`. The model catalogue selected
and confirmed Haiku. A model turn returned the exact unique fixture marker.
After closing the source stream, the same authenticated source loaded the same
session on a new connection and recalled that marker. The other existing Windows
source was denied `session/load` with code `-32001` for this probe session.

A third connection requested compaction once. The controller emitted in-progress
and completed states; the following model turn recalled the original marker.
Three model turns and one compaction request were made. No tools were requested
or executed. Source MCP/plugin provenance discovery remained disabled. All probe
source streams were closed; the probe transcript and ownership record were kept.
No existing user conversation was used or replayed.

This is real PAC protocol/model evidence, including same-source resume,
cross-source denial and context retention after compaction. It is not installed
OpenCode/HAPI UI acceptance, migrated legacy-session model replay, native source
plugin acceptance, or proof of the complete tool/permission matrix.
