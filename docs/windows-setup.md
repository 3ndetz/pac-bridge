# Windows setup from a Git checkout

This is the reviewed **fresh-profile preview** for Windows x64. For a profile already connected to HAPI, do not overwrite its settings or run the fresh installer: its existing hub, runner, credentials, workspace roots, and sessions need a reviewed in-place integration. A second Windows profile can have a different hub and key. Never substitute the key of another hub.

1. Install Git for Windows, Node.js 24 with npm, and OpenCode 1.19.5. The pinned OpenCode command below installs it separately for this user:

   ```powershell
   $prefix = Join-Path $env:LOCALAPPDATA 'PAC-Bridge\opencode-1.19.5'
   npm.cmd install --prefix $prefix opencode-ai@1.19.5 --no-audit --no-fund
   $openCode = Join-Path $prefix 'node_modules\opencode-windows-x64\bin\opencode.exe'
   & $openCode --version
   ```

2. Clone the integration branch. All source and setup scripts are in this checkout:

   ```powershell
   git clone --branch work/pac-bridge-integration https://github.com/3ndetz/pac-bridge.git
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

Detailed installer behavior and a copyable agent prompt are in [windows/README.md](../windows/README.md). Current acceptance gaps are in [RELIABILITY-CHECKLIST.md](../RELIABILITY-CHECKLIST.md).
