# Authenticated source and controller session ownership

The relay authenticates the source before opening a controller channel. It derives a SHA-256 principal scoped to the PAC name and includes that principal in the registration-side `open` message. Source-provided identity headers and ACP metadata are not authoritative. The agent accepts only a valid relay principal and passes it to the controller through `PAC_SOURCE_PRINCIPAL`, replacing case variants inherited from its environment. An older relay that omits this identity is refused before spawning a controller.

By default the principal depends on the authorized source credential hash. A relay authorization entry can also contain `sourceIds`, an object mapping an authorized source SHA-256 credential hash to an operator-assigned identifier. IDs use the same 1?64 character alphabet as PAC names. Map old and replacement hashes to the same ID to preserve session ownership during rotation. Unmapped credential rotation deliberately changes identity. One source credential shared by several clients represents one principal; it does not isolate those clients. Use distinct credentials and distinct IDs for distinct trust domains.

The controller records ownership under `CLAUDE_CONFIG_DIR/pac-session-owners-v1`, falling back to the controller's normal `.claude` directory. An operator can select an absolute `PAC_SESSION_OWNERS_DIR` before launching the agent. Source ACP parameters cannot select this location. Back up this directory together with the corresponding transcripts and preserve access restrictions. It belongs to the trusted controller OS account; its parents must also be trusted. POSIX creation requests private modes. Windows requires an appropriately restricted existing profile ACL; this code does not claim to configure or verify Windows ACL isolation.

Records are write-once and keyed by a hash of the session ID. A missing, incomplete, oversized, linked or invalid record denies access. Competing claims cannot overwrite a different owner. New and forked sessions are bound before a successful response. Load, resume, prompt, steering, goals, cancellation, background task stop, mode/config changes, close and deletion check ownership before calling the SDK. Listings omit unbound or other-owned sessions. SDK options that could redirect identity (`resume`, `continue`, `sessionId`, and related fork/resume controls) are rejected instead of overriding the checked session ID. PAC hook and task extensions also check ownership.

An interrupted claim is retained for operator review, not automatically repaired. If persistence fails after SDK session creation, the controller attempts to close the newly created SDK session and reports failure. Legacy transcripts without ownership are not automatically adopted, even when a caller knows their IDs. An audited migration and backup/rollback procedure are required before replacing an existing installation. The deployed two-source migration and its 150 reviewed legacy records are recorded in [acceptance](../ACCEPTANCE.md#installed-generation-handoff-17-november-2026). This never authorizes automatic adoption of unreviewed transcripts.

This protects the controller's session API across different authenticated source credentials. It is not an OS sandbox, does not defend against a hostile process already running as the controller OS user, and does not establish isolation between local callers sharing one provider bearer. The experimental shared-provider permission controls remain unavailable pending that separate boundary. Unsupported source MCP/plugin provenance discovery remains disabled. Installed two-machine acceptance remains outstanding.

## Reviewed legacy migration

`scripts/migrate-session-owners.mjs` is an operator-only command, not an ACP endpoint. Prepare a private JSON manifest from retained trusted source binding records, the intended relay credential principal and backups. Each binding requires `sessionId`, a 64-character lowercase hex `principal`, and a nonempty `evidence` reference to the reviewed source record/backup. The enclosing object is `{ "version": 1, "bindings": [...] }`. Never collect the mapping from arbitrary remote requests or include raw credentials. Keep the manifest outside Git.

Run the read-only plan:

```text
node scripts/migrate-session-owners.mjs --mapping <absolute-private-json> --owners-dir <absolute-controller-ownership-directory>
```

It prints only a fingerprint and counts. It creates no ownership directory. Review the manifest and target, then use the returned fingerprint:

```text
node scripts/migrate-session-owners.mjs --mapping <absolute-private-json> --owners-dir <absolute-controller-ownership-directory> --apply --plan-hash <reviewed-sha256>
```

The fingerprint binds the normalized entries, evidence and target directory. Existing different owners are rejected before any new claim, and claims remain exclusive if a conflict races application. Interrupted application can be rerun with the same reviewed manifest; completed matching claims are idempotent. Invalid partial records require separate operator review. This command does not scan or rewrite transcripts, infer ownership, alter relay credentials, delete records, or replace backup/rollback preparation. Synthetic Windows/Linux verification is not evidence that the deployed legacy sessions were migrated.
