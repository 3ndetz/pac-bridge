# PAC Bridge: requirements and acceptance

## Purpose and status

This document consolidates the owner's requests made on 7–10 November 2026. It is the target contract, not a claim that the implementation meets it. The first delivery is OpenCode through the existing HAPI installation. The public project and all its documentation are in English.

## Required user experience

1. On a source machine, open the existing HAPI, choose that machine and an installed harness, initially OpenCode, and create a session in the normal new-session interface.
2. Before creating the session, select a model in the form `PAC_<name>/<model>`. The selection identifies a particular named PAC and one of the models actually available on that PAC.
3. Send a prompt in that HAPI session. The chosen authenticated Claude Code runtime on the chosen PAC performs the agent work; tool operations intended for the source workspace execute on the source machine. Events, prompts, outputs and results appear in the same HAPI session.
4. No Claude Code sign-in is required on the source machine. Existing Claude Code authentication stays on the controller. A PAC controller can run natively on Windows using an already authenticated Claude Code installation.
5. This must work for the owner's two requested Windows source machines and the existing shared HAPI, including the ordinary installed runner and user account. An isolated test hub or a manually launched script alone does not satisfy this requirement.

## Functional requirements requested by the owner

- **Full translation:** forward operations and their inputs, results, errors and lifecycle between the source harness and the remote Claude Code runtime. The owner requires the whole exposed functionality, not a selected subset of file operations. Where the two harnesses represent an operation differently, preserve its user-visible and operational semantics and make any gap explicit.
- **Tools and workspaces:** source-side file reads, writes, edits, searches, shell commands and other tool calls must operate in the intended source workspace. Exchange commands and results over the bridge; do not require a shared filesystem, a mounted workspace, or copying the whole workspace between machines.
- **Models:** discover, display and use the models available to the selected PAC. The chosen model must be the model actually used by the remote runtime, including when the user changes it where supported.
- **Background work:** carry tasks, background commands and subagents, including their events, progress, results and controls; nested and concurrent work must remain attributable to the right parent and session.
- **Claude Code features:** retain hooks, skills, instructions, custom commands and other exposed features, with their intended execution context and effects. The target integration must have at least the functionality of the Claude Code features it bridges; similar feature names do not establish parity.
- **Named PACs and multiple clients:** support several independently authenticated PACs, distinguish them by name and identity, and allow clients on different machines to select and use the intended PAC. The architecture must allow multiple source and destination harness adapters.
- **Platforms:** support Windows, macOS and Linux as controller and workspace hosts. Preserve the semantics of the platform on which an operation runs. Git Bash may be used on Windows when appropriate; Docker is optional, not a prerequisite.
- **HAPI:** integrate with the existing HAPI user workflow and its installed harness selection. The bridge's transport can be independent of HAPI if that is the suitable design; the owner's question about using HAPI sessions as transport was an architectural option, not a mandate to use them as the data plane.
- **Harness choice:** OpenCode is the agreed first implementation. Investigate Pi and Oh My Pi against the same functional requirements; an earlier request to start with OMP was superseded by the later instruction to start with OpenCode. A local Claude Code harness with remote PAC authentication was considered, not established as a required design.
- **Delivery:** publish the project and acceptance documentation in an English-language public GitHub repository. Complete implementation, deployment and end-to-end acceptance autonomously; a prototype or instructions for the owner to run a private test do not constitute delivery.

## Engineering conditions derived from those requirements

These conditions make the requested behavior testable and safe; they are implementation and acceptance consequences, not separate quoted owner decisions.

- Authenticate and authorize peers, protect transport and keep credentials and private infrastructure details out of the public repository, client output and logs. PAC names are labels, not credentials.
- Bind each session and every event, model selection, tool invocation, approval and task to the correct source, workspace and PAC. Duplicate names must be rejected or unambiguously disambiguated. Offline or unauthorized PACs must not be presented as usable.
- Propagate permission requests, interactive questions, answers, cancellation and failures. A failure or unsupported feature must be visible; do not silently execute on another host, switch PACs or report success.
- A disconnect during a side-effecting operation must not cause an automatic replay with an unknown outcome. Reconnect and resume must recover state where supported and clearly report anything that cannot be recovered.
- Identify capability gaps explicitly. A deliberately restricted prototype, unsupported feature or unverified behavior is not evidence of full Claude Code parity.

## Acceptance

All items below must pass on the actual delivery path. Record versions, platform, setup, observed result and reproducible evidence. A skipped test is not a pass.

1. **Real HAPI workflow:** on each of the two requested source machines, create a new session in the existing HAPI UI, select OpenCode and the intended named PAC model before creation, send a message and confirm the selected remote Claude runtime and actual model. No source-side Claude login is needed.
2. **Separate hosts and isolation:** use distinct fixtures on source and controller. Exercise read, write, edit and search and verify exact results and source-side effects while the controller fixture remains untouched. Run concurrent sessions in distinct workspaces and verify no crossed events, permissions or side effects.
3. **Streaming and errors:** verify streamed response and tool progress, correct tool results, nonzero exit status, remote errors and explicit unsupported-capability errors in the originating HAPI session.
4. **Shell and cancellation:** run successful, failing, long-running and cancelled commands, including Unicode, spaces and platform-specific paths. Check working directory, output, exit status, cancellation and descendant cleanup. Exercise native Windows, Linux and macOS hosts in both source and controller roles.
5. **Questions and permissions:** approve and deny tool calls; exercise a question with choices, free text and multi-select, and cancel a pending prompt. Verify the exact decision reaches only its originating call and that denied or cancelled operations do not start.
6. **Background work and subagents:** start parallel background commands and nested subagents; observe identity, parent, progress, completion and result, cancel one branch without affecting the others, and verify the remaining work completes. Repeat with reconnect and resume, including work in progress.
7. **Features and dynamic tools:** verify hooks, skills, instructions and custom commands in their intended context, including success, failure, ordering, permissions and effects. Invoke existing and dynamically added MCP or other supported tools; verify discovery, invocation, results and events. Account for every exposed feature in a versioned parity matrix.
8. **Several PACs:** use at least two independently authenticated controllers with distinguishable names and model catalogs. Select each from at least two clients, prove routing and model choice, and exercise simultaneous sessions, authorization, duplicate names, rename, offline state and reconnect without cross-routing.
9. **Recovery:** resume a completed session and interrupt transport during active work, pending approval and a side-effecting operation. Confirm restored state or a clear limitation and unknown outcome; verify no duplicate side effect or silent new session.
10. **Delivery and operation:** install into the existing HAPI and runner environments, verify normal UI operation for the intended users, restart and upgrade behavior, monitoring and rollback. Run without Docker or a shared filesystem. Publish the implementation, English documentation, setup instructions, evidence and remaining limitations without secrets or private environment details.
11. **Harness evaluation:** compare OpenCode, Pi and Oh My Pi against the same matrix using real integration scenarios. Report verified behavior and gaps; do not claim feature parity based only on documentation or similarly named capabilities.

The system is accepted only when the complete applicable matrix passes. Partial test results and isolated prototypes can be reported as progress, not as completion.

## Request history and interpretation

The owner first requested a native Windows controller using an existing Claude Code login, then corrected the proposed shared-filesystem approach: the bridge must transmit operations and results. The owner added model choice, cross-platform support, background tasks, subagents, hooks, skills, named PACs, multiple clients and extensible harnesses; asked for a public English repository and acceptance criteria; explored OMP, OpenCode and direct Claude Code options; and finally selected OpenCode as the first path. The owner repeatedly clarified that the result must be usable from the ordinary HAPI session-creation interface and completed and tested end to end. Questions about access instructions, machine connectivity, authentication and the failed Codex session were operational context rather than additional product features.
