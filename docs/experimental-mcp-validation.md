# Experimental MCP validation

The source MCP integration remains experimental and is not approved for production use. Local synthetic tests exercise permissions, session binding, disconnection and cancellation; they do not establish a trusted client identity boundary or end-to-end authorization.

A Windows synthetic local transport run passed 13 of 14 tests. The disconnect/timeout scenario failed because termination of its job host could not be confirmed. No matching fixture Node process was observed afterwards; that observation does not establish the job host's state or the cause. Resolve and verify process ownership and cleanup before relying on this path.

Remaining work:

- Review and preserve the pending integration changes and test fixtures; remove internal identifiers before public publication.
- Diagnose the unconfirmed Windows job-host termination and verify cleanup with ownership evidence.
- Establish and test client-to-session authorization before enabling shared-provider task controls or source MCP access.
- Complete the installation, recovery and real-runtime acceptance checks recorded in the reliability checklist before production rollout.
- Implement and verify private Windows transcript handling in the actual hook path; isolated ACL and cleanup probes alone are insufficient.
- Verify compatibility with the source profile, including its configured hooks and proxy settings, without silently dropping policy or exposing credentials.
- Verify process ownership and parent-exit behavior end to end before enabling any unfinished Windows parent watcher.
- Merge and push only the verified integration, then reconcile remaining local work and check the final repository status.

A separate synthetic ACP-session test encountered the same unconfirmed Windows host stop after rejecting an unrelated background snapshot. This points to a shared process-lifecycle path, but does not establish why termination failed. Keep the failure visible; do not infer successful cleanup from a failed stop request.

The source-runtime manifest and lockfile pin the MCP SDK. A clean synthetic dependency installation and module imports passed without running npm scripts, a server or a model. The router defers MCP imports until the test-only route is selected; disabled-path startup was also checked without the SDK. Optional provenance discovery is explicitly disabled before opening a session. The experimental route remains unverified in the installed source runtime and is not ready for deployment.

Eight session, permission, controller and quiescence tests passed in an isolated Linux container without network access, using the repository's development dependencies and synthetic collaborators. This does not validate the installed source runtime, a real MCP server, or the client authorization boundary.

An archived committed snapshot also passed 54 selected synthetic ACP, barrier, session and permission tests in a network-isolated Linux container. A separate provider, ACP proxy and background-terminal test run succeeded in the same kind of container; its two installed-OpenCode checks were skipped. The snapshot used existing development dependencies, not a clean dependency installation. These results do not establish real-runtime acceptance or safe process cleanup on Windows.

Node 24.18's [process wrapper](https://github.com/nodejs/node/blob/v24.18.0/src/process_wrap.cc) calls `uv_process_kill` with its process object; [libuv's process documentation](https://docs.libuv.org/en/v1.x/process.html) distinguishes that from signaling a cached PID. The [Node child-process documentation](https://nodejs.org/download/release/v24.22.2/docs/api/child_process.html) nevertheless warns about PID reuse and notes that `kill()` returning successfully does not prove termination. These sources alone do not establish safe ownership or descendant cleanup for this integration; an observed exit and an independently verified owned job lifecycle remain necessary.

A separate isolated Linux container checked the unlinked hook transcript after a synthetic process was terminated through a retained pidfd. The test verified process exit and disappearance of the transcript path; it does not establish Windows transcript privacy or recovery from every crash.

A synthetic Windows ACL probe rejected broad access and reparse roots, and checked handle behavior during a rename attempt and concurrent writes. With read-only sharing, the synthetic open file also blocked the tested directory replacement. An isolated process that exited through Environment.Exit without cleanup also released its synthetic delete-on-close file. A separate synthetic process was terminated through its own retained Windows Job Object; the job reported zero active processes and the synthetic file had disappeared before cleanup. These tests do not establish private Windows transcript handling or recovery from every crash.

The committed branch snapshot was exercised with the default Node test selection in a network-isolated Linux container using existing development dependencies. The sole reported failure was the search test because that container lacked ripgrep; the same test passed separately in an isolated image containing ripgrep. Opt-in live and platform-specific scenarios were not established by this run, and uncommitted files were excluded.

A separate synthetic Windows job harness confirmed its own job had zero active processes before workspace cleanup in early-exit and timeout scenarios. It uses a retained job handle and a bounded control deadline. This does not establish ownership or repair the separate production job-host failure.

Two synthetic ACP invalid-or-stale snapshot cases were rerun on Windows inside an owned job. The harness verified both cases ran and passed, then confirmed the job had no active processes before cleanup. This does not establish the cause of the earlier job-host failure or prove all shutdown paths safe.

The earlier failing local synthetic MCP disconnect/timeout case was rerun on Windows inside an owned job: the intended case passed and the harness confirmed zero active processes before cleaning up. The earlier failure's cause remains unknown, and this isolated repeat does not establish safe behavior for all shutdown paths.

All 15 local synthetic MCP transport tests subsequently passed on Windows inside the owned job, whose zero-active-process check completed before cleanup. No user MCP configuration or real server was used. The earlier failure's cause remains unknown and real-runtime authorization remains unverified.
