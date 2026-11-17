# OpenCode skills, rules and plugins

The source harness is OpenCode. Its source workspace, skills and instructions are forwarded to the selected PAC. Claude Code runs only on that PAC as the remote agent runtime. Installing, signing in to, or configuring Claude Code on the source machine is not required.

## Source configuration boundary

The adapter does not read local Claude `settings.json`, `settings.local.json`, `CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules` or `.claude/skills`. It does not execute local Claude hooks or forward local Claude proxy/model preferences to the PAC. The source OpenCode child is launched with `OPENCODE_DISABLE_CLAUDE_CODE=1` to enforce the same boundary in its own compatibility discovery. This is scoped to the launched source process; no user profile file is edited. Remote PAC authentication and runtime network settings remain on the PAC.

## Skills

Supported file-backed skills are discovered in project `.opencode/skill`, `.opencode/skills` and `.agents/skills`, and global OpenCode/agents directories. The OpenCode config root follows `XDG_CONFIG_HOME` (otherwise `~/.config/opencode`); `OPENCODE_CONFIG_DIR` contributes its own skills. Project traversal stops at the Git boundary or home boundary. `OPENCODE_DISABLE_PROJECT_CONFIG` disables project skill discovery. Nearer project definitions take precedence over ancestor/global definitions. Ambiguous same-rank names still fail explicitly.

A supported skill has simple name/description frontmatter; string license/compatibility fields and a string-to-string metadata map are accepted. Its resource files remain on the source machine and are accessible through the bridge after invocation. Built-in skill discovery remains bounded and guarded against unsupported plugins. Custom skill configuration, other frontmatter and dynamic substitutions are not generally supported. These restrictions do not establish complete native skill parity.

## Instructions

The adapter loads the nearest project `AGENTS.md` within its Git boundary and global OpenCode `AGENTS.md` independently. Legacy OpenCode `CONTEXT.md` is considered only if no project `AGENTS.md` exists. Nearby nested `AGENTS.md` files are supplied when their source files are accessed. Reads have file/total size limits, UTF-8 validation and filesystem boundaries. Text containing `@file` is not automatically expanded. Local Claude fallback files and path-scoped Claude rules are excluded.

The [pinned OpenCode instruction implementation](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/session/instruction.ts) defines the native precedence being followed. Claude compatibility is deliberately disabled for this source integration. Configured extra instruction paths remain explicitly unsupported until their configuration and access rules are implemented.

## Plugins and hooks

OpenCode plugins and their hooks are native OpenCode features. Running a similarly named Claude hook does not implement them. Unsupported configured OpenCode plugins, permissions, MCP and extra instruction/skill configuration still stop a PAC turn with an explanation; the guard has not been relaxed. Model listing can remain available without claiming those features work.

Earlier local Claude hook checks are retained as [isolated experiment evidence](claude-hook-experiments.md), not current OpenCode acceptance. Completion notifications are a separate [bridge callback](telegram-notifications.md), not a substitute for native OpenCode plugins. Remaining delivery checks are in [the worklist](completion-worklist.md).
