# Windows setup from the repository

This procedure targets an **existing configured HAPI runner**, under the Windows account that owns it. It uses the existing hub and machine identity, and installs PAC Bridge as a separate OpenCode provider. It does not install or replace HAPI. Linux and macOS installation is not yet fully verified.

The provider has been exercised on two Windows profiles. The bootstrap below is new and needs a clean-profile end-to-end test before it can be regarded as a finished installer. Existing PAC deployments must follow their migration procedure rather than overwrite their configuration.

1. Install Git for Windows, Node.js 24 with npm, and OpenCode 1.19.5. The verified OpenCode version can be installed for the current user:

   ```powershell
   $prefix = Join-Path $env:LOCALAPPDATA 'PAC-Bridge\opencode-1.19.5'
   npm.cmd install --prefix $prefix opencode-ai@1.19.5 --no-audit --no-fund
   $openCode = Join-Path $prefix 'node_modules\opencode-windows-x64\bin\opencode.exe'
   & $openCode --version
   ```

2. Clone this repository with `git clone https://github.com/3ndetz/pac-bridge.git` and enter the checkout. Have the existing permanent ServerMallAgents kit path available. The profile must already connect to the intended existing HAPI hub.
3. Transfer a private directory containing `connection.json`, `pac-source-token.txt`, and `pac-relay-ca.pem` through an appropriately protected channel. The JSON must provide `relayUrl`, `pacName`, and `controllerCwd`, with optional `displayName` and `modelPrefix`. The PAC source token grants access to the controller; never commit it or send its contents through chat. Claude login stays on the controller. The existing HAPI profile supplies its own hub credentials and identity.

   The legacy `Claude` model prefix is applied to recognizable Claude model names only. Models from another family, such as Codex, keep their own name. This changes display labels, not model identifiers or routing; ambiguous names are left without the Claude prefix.
4. Run under the account owning the existing runner:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\windows\Configure-ExistingProvider.ps1 `
     -KitPath C:\Tools\ServerMallAgents `
     -KeysPath C:\Private\PAC-Bridge-keys `
     -OpenCodePath $openCode
   ```

   This stages versioned repository source and the locked source-side dependencies from `source-package/`, then configures the existing kit for the next runner start. The source machine does not need the controller-only Claude SDK or its executable. It does not restart the runner or active chats. A PAC profile already present stops the script for a reviewed migration. If installation is interrupted, preserve the profile and inspect the `pac-bridge` directory and `Runtime.ps1` before retrying.
5. At a suitable time restart the existing runner using the kit's normal procedure. In the existing HAPI, create an OpenCode chat on that machine and choose a `PAC #N / …` model. Verify a real answer, compaction and recall. A test of the installed runner is available in `scripts/verify-installed-hapi.mjs`; it creates and archives its own test chat and requires `PAC_TEST_INSTALLED=1`, a permitted workspace, and a PAC model ID.

To update an already configured provider, fetch and pull the repository, then run `windows/Install-ProviderMode.ps1 -KitPath <kit> -Activate -NamedProviders`. Existing sessions may require the separately reviewed `-LegacyMigration` option. With a dispatch-enabled wrapper, newly launched chats use the selected revision immediately; older fixed wrappers require a runner restart or the reviewed migration below. `windows/Disable-ProviderMode.ps1` disables the provider loader without replacing HAPI. Inspect the specific profile and preserve its backups when rolling back a migration.

New provider-mode wrappers follow the selected staged revision for newly launched OpenCode processes, including after a runner restart. Existing chats keep their original process and version. For an older running runner whose generated wrapper still pins a particular revision, `windows/Enable-LiveProviderDispatch.ps1 -WrapperRevision <full-revision>` can migrate that wrapper after checking its exact contents; `-Restore` restores its verified backup. Determine the wrapper actually used by that runner before running this command. A running conversation is not migrated by this operation. Disabling the loader takes effect after restarting the runner; use the verified wrapper restore as well when immediately undoing a live-dispatch migration.

Older `Install-FromRepo.ps1`, `Install-PacRunner.ps1`, and `Install-ExistingProfile.ps1` describe the superseded PAC-patched runtime and should not be used for this provider setup. Follow [RELIABILITY-CHECKLIST.md](../RELIABILITY-CHECKLIST.md) for remaining limitations.

To check every currently advertised PAC model in one temporary HAPI chat, run
`$env:PAC_TEST_INSTALLED='1'; node scripts/verify-windows-pac-models.mjs` from
the repository. This sends one real prompt per model and consumes model quota.
The temporary launcher disables completion notifications for this test only;
the installed notification configuration is unchanged. The check confirms
selection and a response for each advertised ID, not the controller's internal
mapping from aliases to model implementations. It archives its own chat and
removes its own workspace only after confirming the archive; an uncertain
cleanup is reported with the test session and workspace for inspection.

## Prompt for an agent on another PC

```text
Configure PAC Bridge for the existing HAPI runner on this Windows account using
https://github.com/3ndetz/pac-bridge and docs/windows-setup.md. Keep this hub,
machine identity, existing sessions and runtime. Use the private connection
files supplied separately; never print or commit them. Do not create another
HAPI hub or install a PAC-patched HAPI executable. Install prerequisites and
the repository provider, then verify model discovery, a real PAC answer, manual
compaction and context recall. Report each check and every unresolved issue.
```

For the currently prepared transfer, the source files are in
`%USERPROFILE%\Downloads\PAC-Bridge-keys` on the first Windows machine.
Only `connection.json`, `pac-source-token.txt`, and `pac-relay-ca.pem` are used
when the destination already has its own HAPI profile. The separate
`hapi-token.txt` in that directory is not required for that scenario. Transfer
the required files securely and keep them accessible only to the account that
owns the destination runner. The existing HAPI token is not a PAC source token.
