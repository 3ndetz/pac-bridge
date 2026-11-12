# Skills and hooks

PAC Bridge discovers supported skills on the source machine in project `.opencode/skill`, `.opencode/skills`, `.agents/skills`, and `.claude/skills`, as well as the corresponding supported user directories. A supported skill has simple `name` and `description` frontmatter. When invoked, its own resource files can be read from the source machine. Other metadata, dynamic substitutions, custom skill paths, and native OpenCode plugin hooks are not yet generally supported.

The bridge supports source project command hooks in `.claude/settings.json` and `.claude/settings.local.json` for `PreToolUse`, `PostToolUse`, and `PostToolUseFailure`. Hooks run on the source machine; a pre-tool denial prevents the tool from running. Security-relevant configuration the bridge cannot enforce is rejected instead of being silently ignored. Other hook events and OpenCode plugin APIs are not complete. See [the experiment documentation](../OPENCODE-EXPERIMENT.md) for the exact constraints.

On the existing Windows HAPI runner, real-Claude checks have exercised a project OpenCode skill and its resource, a pre-tool denial, a successful post-tool hook, and a post-tool failure hook. These are scenario-specific results, not proof that every installed skill, plugin, event, or platform is supported. The complete matrix is tracked in [RELIABILITY-CHECKLIST.md](../RELIABILITY-CHECKLIST.md).

The experimental OpenCode provider path was also checked with an unmodified HAPI 0.34.4 client in the existing TS-1CDEV hub: the project skill resource, the three hook scenarios, an explicit approval of a test file write, and non-disclosure of a denied test file all passed. The client was a separate process and the `/workflow/4/` hub uses the corporate baseline; the `/workflow/1/` hub and shared UI still include PAC-specific changes. Global skills and other hooks or plugins have not yet been verified in provider mode.

An optional source-side completion notification is documented separately in [telegram-notifications.md](telegram-notifications.md). It is a bridge completion callback; it does not claim general compatibility with OpenCode plugin hooks.
