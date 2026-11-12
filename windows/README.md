# Windows: connect another source machine

**Status:** the fresh-profile installer is under verification. See [setup from a Git checkout](../docs/windows-setup.md) and [the reliability checklist](../RELIABILITY-CHECKLIST.md).

This connects a new Windows runner to the existing HAPI hub specified in the private connection file. It does not enroll a new HAPI hub. Each machine retains its own runner identity and local project files. Claude authentication stays on the PAC controller.

**Important:** Existing deployments can use separate HAPI hubs and credentials for different Windows accounts or machines. Confirm the intended account, hub URL and runner before installation. The bundled example connection files for one hub do not authorize access to another. For an existing HAPI profile, this fresh-profile installer deliberately stops; a reviewed integration into that profile is required. Attaching a temporary runner to another machine's hub is not acceptance of the existing target hub.

## Requirements

* Windows 10 or 11, PowerShell 5.1, Node.js 24 with npm, Git for Windows in its normal location, and native OpenCode 1.19.5.
* Network access to the existing HAPI gateway, the private PAC relay, npm, and the software download sources. The private relay requires the appropriate corporate network or VPN.
* ServerMallAgents connection kit `0.34.4-sm4` or a reviewed compatible successor, extracted into a **permanent** directory. Its published download is <https://apps.servermall.ru/workflow/sma-connection-kit.zip>. Its `Install-Runner.ps1` uses the existing hub access token; do not run the new-machine enrollment command.
* A separate private directory containing `connection.json`, `hapi-token.txt`, `pac-source-token.txt`, and `pac-relay-ca.pem`. Never put these files into Git, an archive published on GitHub, logs, or chat. The HAPI token grants access to the existing hub and its sessions; only transfer it to a trusted machine and user account.
* A checkout of this repository with `package-lock.json` and the `windows` directory. `Install-FromRepo.ps1` downloads the reviewed HAPI executable individually and checks it against `runtime-manifest.json`; a PAC Bridge archive is not required.

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
& C:\Path\To\pac-bridge\windows\Install-FromRepo.ps1 `
  -KitPath C:\Tools\ServerMallAgents `
  -KeysPath C:\Private\PAC-Bridge-keys `
  -OpenCodePath C:\Path\To\opencode.exe
```

The installer installs PAC Bridge under the user's `.hapi-servermall` directory, creates a local runtime configuration, invokes the kit's runner installer for the existing hub, and installs the verified PAC-aware HAPI runtime. It writes a profile-specific runtime pin, which a compatible managed kit checks by SHA-256 and retains during repair. A kit targeting a different HAPI base version stops for review instead of silently replacing the runtime. The installer refuses to overwrite an existing HAPI profile, PAC installation, or local `Runtime.ps1`. An existing installation needs a reviewed merge and restart procedure; do not delete it to force this installer to run. If installation is interrupted, inspect and recover the partial profile before retrying.

After installation, open the existing HAPI hub. Select the newly registered machine, create an OpenCode chat in a safe temporary project and select `PAC #1 / Claude ...`. Confirm a real response and a permitted read/write in that project. Reboot the source machine, verify the runner reconnects, reopen the session, and confirm history and another response. Report failures rather than treating model discovery as success.

## Prompt for an agent on the other PC

```text
Clone https://github.com/3ndetz/pac-bridge on branch work/pac-bridge-integration and read docs/windows-setup.md and RELIABILITY-CHECKLIST.md. Set up this Windows PC for PAC Bridge using the intended existing HAPI hub and its own credentials. Use the supplied private PAC-Bridge-keys directory; never print, commit, or upload its contents. Install or verify Node.js 24, Git for Windows, and OpenCode 1.19.5. Obtain the current ServerMallAgents kit from the URL in the instructions and extract it into a permanent directory. For a fresh profile use windows/Install-FromRepo.ps1; do not register a new HAPI hub. Preserve any existing HAPI configuration and use a reviewed integration if one already exists. Verify actual model selection, a real response and source file operations, then restart and verify reconnection and session continuity. Report exactly what passed and what remains unverified.
```
