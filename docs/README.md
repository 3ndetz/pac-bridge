# Setup documentation

- [Windows: install from this repository](windows-setup.md). This configures PAC on an existing HAPI profile; establishing a fresh HAPI profile remains a separate procedure.
- [Linux and macOS: current development setup](posix-setup.md). Automated production installation and end-to-end acceptance on these systems remain open.
- [Updating, coordinated migration and rollback](updating.md).
- [Authenticated source and session ownership](session-authorization.md).
- [Optional Telegram completion notifications](telegram-notifications.md).
- [OpenCode source skills, rules and plugin limitations](skills-hooks.md), [acceptance and limitations](../RELIABILITY-CHECKLIST.md).

Scripts live in `windows/`, `adapters/`, and `src/` in this repository. Credentials and private connection files are distributed separately; never commit them.
