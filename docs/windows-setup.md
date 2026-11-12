# Windows setup from a Git checkout

This is the **Windows x64 preview**. A second Windows profile can have a different hub and key. Never substitute the key of another hub.

1. Install Git for Windows, Node.js 24 with npm, and OpenCode 1.19.5. The pinned OpenCode command below installs it separately for this user:

   ```powershell
   $prefix = Join-Path $env:LOCALAPPDATA 'PAC-Bridge\opencode-1.19.5'
   npm.cmd install --prefix $prefix opencode-ai@1.19.5 --no-audit --no-fund
   $openCode = Join-Path $prefix 'node_modules\opencode-windows-x64\bin\opencode.exe'
   & $openCode --version
   ```

2. Clone the integration branch. All source and setup scripts are in this checkout:

   ```powershell
   git clone https://github.com/3ndetz/pac-bridge.git
   cd pac-bridge
   ```

3. Obtain the compatible ServerMallAgents kit from its administrator and extract it into a permanent directory. The current kit is available at `https://apps.servermall.ru/workflow/sma-connection-kit.zip`. This corporate kit is separate from PAC Bridge. Obtain a private directory containing `connection.json`, `hapi-token.txt`, `pac-source-token.txt`, and `pac-relay-ca.pem` for the **intended existing hub**. The hub token grants access to that hub and its sessions. Transfer these files securely, never through Git or chat. Claude's login stays on the controller.
4. Run the repository script under the Windows account that will own the runner:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\windows\Install-FromRepo.ps1 `
     -KitPath C:\Tools\ServerMallAgents `
     -KeysPath C:\Private\PAC-Bridge-keys `
     -OpenCodePath $openCode
   ```

   The script downloads the reviewed Windows HAPI executable as an individual release asset, verifies its SHA-256 against `windows/runtime-manifest.json`, and then invokes `windows/Install-PacRunner.ps1` from this checkout. To use an already downloaded reviewed binary, pass `-HapiBinaryPath`; its checksum is still required to match. No PAC Bridge archive is needed.

5. Open the intended existing HAPI, create an OpenCode chat in an allowed test directory, select the PAC model, and verify a real answer and permitted source file operations. Verify reconnection and session continuity after a planned restart. The installer does not prove those scenarios by itself.

## Integrating an existing HAPI profile

Do not run the fresh installer against an existing profile. Review the current kit, local `Runtime.ps1`, runtime pin, hub, credentials, workspace roots, and running sessions first. The profile must use a compatible managed kit with runtime pin support, Node 24, Git Bash, and the pinned OpenCode version. Preserve the kit's local settings and backups. Where the profile has no existing PAC integration, no local `Runtime.ps1`, and no user runtime pin, the repository provides this preview script:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\windows\Install-ExistingProfile.ps1 `
  -KitPath C:\Tools\ServerMallAgents `
  -KeysPath C:\Private\PAC-Bridge-keys `
  -OpenCodePath $openCode `
  -HapiBinaryPath C:\Private\hapi-pac.exe
```

The binary can be downloaded as [a single release asset](https://github.com/3ndetz/pac-bridge/releases/download/windows-preview-ffd08bd/hapi-pac.exe); the script verifies its checksum. The target hub URL and machine identity come from the existing profile, not from the supplied source connection file. The script preserves an existing runtime pointer backup, sets a user runtime pin, and invokes the kit's reviewed runtime installer. If an existing runtime customization or pin is present, it stops for a reviewed merge. If interrupted or unsuccessful, inspect the profile and restore service before retrying; do not delete the profile or existing sessions. This script has an isolated synthetic-profile test; individual real deployments require verification.

Detailed installer behavior and a copyable agent prompt are in [windows/README.md](../windows/README.md). Current acceptance gaps are in [RELIABILITY-CHECKLIST.md](../RELIABILITY-CHECKLIST.md).
