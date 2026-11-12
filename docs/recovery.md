# Recovering an uncertain turn

The bridge keeps a pending marker when a turn or compaction may have performed work but did not finish with a confirmed result. It will not replay that turn automatically. Preserve the original HAPI chat and PAC binding while reviewing it.

1. Archive or stop **that chat**, and confirm its local provider process and any background work from the uncertain turn have stopped. Do not restart the hub or unrelated chats for this purpose.
2. Review the chat, affected files and external systems to determine what actually happened. A stopped local process alone does not prove a remote action did not finish. Decide what follow-up is needed without blindly repeating the old request.
3. Obtain the original **OpenCode session ID** from the chat's HAPI session metadata field `opencodeSessionId`. It is not the HAPI session UUID. Do not copy authentication tokens or other metadata into a command or report.
4. From a current Git checkout of this repository, run the following only after the review. Substitute the original OpenCode ID and the absolute journal path for this profile:

   ```powershell
   node .\scripts\reconcile-uncertain-turn.mjs --session-id <opencode-session-id> `
     --journal-dir "$env:USERPROFILE\.hapi-servermall\pac-bridge\bindings\pending" --confirm-reviewed
   ```

   For the POSIX installer, the journal path is `~/.local/share/pac-bridge/bindings/pending`; expand it to an absolute path before passing it. `--confirm-reviewed` is a statement that the preceding review was completed. The command checks that a new-format marker's original process is no longer running and clears only that session's marker. It does not send a prompt, repeat a tool call or change the saved session binding. If no marker exists, nothing is changed.

Markers created by older bridge versions do not record a process identity. After independently confirming that the original provider process is stopped, add `--legacy-owner-stopped` as a separate explicit confirmation. Never use it while a duplicate or old provider for that session may still run.

If the command reports that the journal is locked, do not delete the lock while another provider or recovery command might be running. A crash during the short journal update can leave a stale lock; inspect the specific session and running processes before resolving it. Automatic stale-lock recovery is not implemented. These recovery instructions do not establish that every interruption, background task or remote side effect is automatically recoverable.
