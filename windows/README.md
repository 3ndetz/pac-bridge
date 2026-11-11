# Windows: connect another source machine

**Status:** the installer is under verification. The second-machine, real HAPI and real Claude acceptance checks remain open; do not treat a successful installation as proof of end-to-end operation. See [the reliability checklist](../RELIABILITY-CHECKLIST.md).

This connects a new Windows runner to the existing HAPI hub specified in the private connection file. It does not enroll a new HAPI hub. Each machine retains its own runner identity and local project files. Claude authentication stays on the PAC controller.

## Requirements

* Windows 10 or 11, PowerShell 5.1, Node.js 24 with npm, Git for Windows in its normal location, and native OpenCode 1.19.5.
* Network access to the existing HAPI gateway, the private PAC relay, npm, and the software download sources. The private relay requires the appropriate corporate network or VPN.
* The current ServerMallAgents connection kit extracted into a **permanent** directory. Its published download is <https://apps.servermall.ru/workflow/sma-connection-kit.zip>. Its `Install-Runner.ps1` uses the existing hub access token; do not run the new-machine enrollment command.
* A separate private directory containing `connection.json`, `hapi-token.txt`, `pac-source-token.txt`, and `pac-relay-ca.pem`. Never put these files into Git, an archive published on GitHub, logs, or chat. The HAPI token grants access to the existing hub and its sessions; only transfer it to a trusted machine and user account.
* A complete PAC Bridge source archive, extracted into a permanent or temporary directory, with `package-lock.json` and this `windows` directory.

On an x64 machine, an isolated installation of the pinned OpenCode binary can be prepared without replacing an existing version:

```powershell
$prefix = Join-Path $env:LOCALAPPDATA 'PAC-Bridge\opencode-1.19.5'
npm.cmd install --prefix $prefix opencode-ai@1.19.5 --no-audit --no-fund
$openCode = Join-Path $prefix 'node_modules\opencode-windows-x64\bin\opencode.exe'
& $openCode --version
```

The last command must report `1.19.5`. Use `$openCode` as the `-OpenCodePath` value below. The example is for x64, not ARM Windows.

For a fresh profile, run from PowerShell as the Windows user who will own the runner:

```powershell
& C:\Path\To\pac-bridge\windows\Install-PacRunner.ps1 `
  -KitPath C:\Tools\ServerMallAgents `
  -KeysPath C:\Private\PAC-Bridge-keys `
  -OpenCodePath C:\Path\To\opencode.exe
```

The installer installs PAC Bridge under the user's `.hapi-servermall` directory, creates a local runtime configuration, and invokes the kit's runner installer for the existing hub. It refuses to overwrite an existing HAPI profile, PAC installation, or local `Runtime.ps1`. An existing installation needs a reviewed merge and restart procedure; do not delete it to force this installer to run. If installation is interrupted, inspect and recover the partial profile before retrying.

After installation, open the existing HAPI hub. Select the newly registered machine, create an OpenCode chat in a safe temporary project and select `PAC #1 / Claude ...`. Confirm a real response and a permitted read/write in that project. Reboot the source machine, verify the runner reconnects, reopen the session, and confirm history and another response. Report failures rather than treating model discovery as success.

## Prompt for an agent on the other PC

```text
Set up this Windows PC as an additional source machine for the existing HAPI hub and PAC Bridge. Read windows/README.md and RELIABILITY-CHECKLIST.md from the supplied PAC Bridge archive first. Use the supplied private PAC-Bridge-keys directory; never print, commit, or upload its contents. Install or verify Node.js 24, Git for Windows, and OpenCode 1.19.5. Obtain the current ServerMallAgents kit from the URL in the instructions and extract it into a permanent directory. Connect to the existing hub using Install-PacRunner.ps1; do not register a new HAPI hub. Preserve any existing HAPI configuration and ask for a reviewed migration if one already exists. Verify actual model selection, a real response and source file operations, then restart and verify reconnection and session continuity. Report exactly what passed and what remains unverified.
```
