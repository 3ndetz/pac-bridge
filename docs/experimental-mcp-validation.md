# Experimental MCP validation

The source MCP integration remains experimental and is not approved for production use. Local synthetic tests exercise permissions, session binding, disconnection and cancellation; they do not establish a trusted client identity boundary or end-to-end authorization.

A Windows synthetic local transport run passed 13 of 14 tests. The disconnect/timeout scenario failed because termination of its job host could not be confirmed. No matching fixture Node process was observed afterwards; that observation does not establish the job host's state or the cause. Resolve and verify process ownership and cleanup before relying on this path.

Remaining work:

- Review and preserve the pending integration changes and test fixtures; remove internal identifiers before public publication.
- Diagnose the unconfirmed Windows job-host termination and verify cleanup with ownership evidence.
- Establish and test client-to-session authorization before enabling shared-provider task controls or source MCP access.
- Complete the installation, recovery and real-runtime acceptance checks recorded in the reliability checklist before production rollout.

A separate synthetic ACP-session test encountered the same unconfirmed Windows host stop after rejecting an unrelated background snapshot. This points to a shared process-lifecycle path, but does not establish why termination failed. Keep the failure visible; do not infer successful cleanup from a failed stop request.

The source-runtime package and lockfile do not declare the MCP SDK required by the experimental source route. A pending router candidate defers that import until the test-only route is selected; a local disabled-path startup check passed with the SDK deliberately unavailable. The experimental route and its dependency remain unverified in the installed source runtime; do not deploy the candidate as-is.

Eight session, permission, controller and quiescence tests passed in an isolated Linux container without network access, using the repository's development dependencies and synthetic collaborators. This does not validate the installed source runtime, a real MCP server, or the client authorization boundary.

Node 24.18's [process wrapper](https://github.com/nodejs/node/blob/v24.18.0/src/process_wrap.cc) calls `uv_process_kill` with its process object; [libuv's process documentation](https://docs.libuv.org/en/v1.x/process.html) distinguishes that from signaling a cached PID. The [Node child-process documentation](https://nodejs.org/download/release/v24.22.2/docs/api/child_process.html) nevertheless warns about PID reuse and notes that `kill()` returning successfully does not prove termination. These sources alone do not establish safe ownership or descendant cleanup for this integration; an observed exit and an independently verified owned job lifecycle remain necessary.

A separate isolated Linux container checked the unlinked hook transcript after a synthetic process was terminated through a retained pidfd. The test verified process exit and disappearance of the transcript path; it does not establish Windows transcript privacy or recovery from every crash.
