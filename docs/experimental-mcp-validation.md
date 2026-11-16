# Experimental MCP validation

The source MCP integration remains experimental and is not approved for production use. Local synthetic tests exercise permissions, session binding, disconnection and cancellation; they do not establish a trusted client identity boundary or end-to-end authorization.

A Windows synthetic local transport run passed 13 of 14 tests. The disconnect/timeout scenario failed because termination of its job host could not be confirmed. No matching fixture Node process was observed afterwards; that observation does not establish the job host's state or the cause. Resolve and verify process ownership and cleanup before relying on this path.
