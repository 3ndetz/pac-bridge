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

   For the POSIX installer, the journal path is `~/.local/share/pac-bridge/bindings/pending`; expand it to an absolute path before passing it. `--confirm-reviewed` is a statement that the preceding review was completed. The command checks that a new-format marker's recorded process ID is no longer in use and clears only that session's marker. An unrelated process that reuses that ID also blocks recovery; process identity alone does not prove a remote action has stopped. The command does not send a prompt, repeat a tool call or change the saved session binding. If no marker exists, nothing is changed.

Markers created by older bridge versions do not record a process identity. After independently confirming that the original provider process is stopped, add `--legacy-owner-stopped` as a separate explicit confirmation. Never use it while a duplicate or old provider for that session may still run.

If the command reports that the journal is locked, do not delete the lock while another provider or recovery command might be running. A crash during the short reconciliation operation can leave a stale lock; ordinary turn creation does not create it. After inspecting the action, confirming that this chat's provider and any concurrent recovery command are stopped, repeat the command with `--clear-stale-lock --confirm-session-stopped`. A new-format lock's recorded process ID must also be unused. For a legacy lock without a process ID, the additional `--legacy-owner-stopped` confirmation is required. The command serializes lock repair against new turns and then reconciles the pending marker.

If the **repair lock itself** was left behind by a crash during that brief repair operation, automatic repair stops rather than guessing which process owns it. Inspect the exact session and concurrent processes before manual intervention. These instructions do not establish that every interruption, background task or remote side effect is automatically recoverable.

For an opt-in end-to-end check on a configured Windows runner, set `PAC_TEST_INSTALLED=1` and run `node test/fixtures/hapi-uncertain-recovery.mjs` from the checkout. The fixture creates its own chat and project, uses real model quota, starts and interrupts a harmless one-line file action, reviews that synthetic result, reconciles it, and checks that the same chat resumes without repeating the action. It archives its own test chat; it must not be run as a routine unit test.
