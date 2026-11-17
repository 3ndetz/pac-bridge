# Windows installer audit candidate

This directory preserves an unfinished installer audit as explicit experimental source. It is not an installation entrypoint and does not replace `windows/` in the product. Existing product entrypoints retain the current main-branch behavior and documented limitations.

The candidate intentionally refuses runtime writes because interrupted exclusive-handle updates were not crash-safe. Its retry and recovery design remains incomplete. The audit tests include reproductions and unsatisfied acceptance tests; they are excluded from the normal `test/*.test.mjs` suite. Do not run the directory as a release suite or copy this candidate over a real profile.

Review the audit and recovery-design documents here for the unresolved cases. Static syntax checks and synthetic filesystem experiments do not establish a safe installation, migration, rollback or power-loss recovery procedure.
