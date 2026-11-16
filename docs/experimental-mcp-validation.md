# Experimental MCP validation

The source MCP integration remains experimental and is not approved for production use. Local synthetic tests exercise permissions, session binding, disconnection and cancellation; they do not establish a trusted client identity boundary or end-to-end authorization.

A Windows synthetic local transport run passed 13 of 14 tests. The disconnect/timeout scenario failed because termination of its job host could not be confirmed. No matching fixture Node process was observed afterwards; that observation does not establish the job host's state or the cause. Resolve and verify process ownership and cleanup before relying on this path.

Remaining work:

- Review and preserve the pending integration changes and test fixtures; remove internal identifiers before public publication.
- Diagnose the unconfirmed Windows job-host termination and verify cleanup with ownership evidence.
- Establish and test client-to-session authorization before enabling shared-provider task controls or source MCP access.
- Complete the installation, recovery and real-runtime acceptance checks recorded in the reliability checklist before production rollout.

A separate synthetic ACP-session test encountered the same unconfirmed Windows host stop after rejecting an unrelated background snapshot. This points to a shared process-lifecycle path, but does not establish why termination failed. Keep the failure visible; do not infer successful cleanup from a failed stop request.

The pending source-router candidate imports the MCP SDK, but the source-runtime package and lockfile do not declare it. Its dependency and initialization path have not been validated in the installed source runtime; do not deploy that candidate as-is.
