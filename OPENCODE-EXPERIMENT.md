# Experimental OpenCode connection

This describes the current development launcher for an already provisioned PAC and relay. It is not a release or a complete installation procedure. See [ACCEPTANCE.md](ACCEPTANCE.md) for verified behavior and outstanding requirements.

The source machine needs Node.js, this checkout with its npm dependencies installed, an OpenCode executable and a local Bash executable. The PAC must already be registered with the relay and have a separately authenticated Claude runtime. Remote relay connections require `wss://`; a source credential is supplied as a file and Claude credentials stay on the controller.

`node adapters/pac-relay.mjs` starts the standalone relay. Set `PAC_RELAY_AUTH_FILE` to a protected JSON file of the form `{"pacs":{"example":{"agentHashes":["<sha256-hex>"],"sourceHashes":["<sha256-hex>"]}}}`. Each hash is a lowercase SHA-256 digest of a separately generated high-entropy token; the controller receives only its agent token and each authorized source receives its source token. Multiple hashes allow staged rotation. The file is read at each handshake; removal prevents new connections but does not terminate established sessions. Restart the relay to disconnect existing sessions. Defaults are loopback `127.0.0.1:8791`; set `PAC_RELAY_HOST` and `PAC_RELAY_PORT` as needed. A non-loopback listener requires both `PAC_RELAY_TLS_KEY` and `PAC_RELAY_TLS_CERT` pointing to PEM files. Clients must trust the certificate. Secure token creation, distribution, OS permissions and service supervision must be arranged for the target environment.

For an isolated first PAC, `node adapters/pac-init-relay-auth.mjs <new-absolute-directory> <pac-name>` creates separate `agent.token`, `source.token` and `relay-auth.json` files without printing credentials or overwriting an existing directory. The parent directory must exist and be private before generation. POSIX permissions are restricted at creation; on Windows, protect the parent ACL so the generated files inherit restrictive permissions, then verify them before use. Place only the agent token on its controller, only the source token on authorized sources, and the hash file on the relay; transfer them through a protected channel.

The experimental controller adapter and its pinned SDK dependencies are included in this checkout; install them with `npm ci` on the controller. The adapter can be started by `adapters/pac-acp-agent.mjs` using `node` and the path to `adapters/pac-claude-agent.mjs` as its executable and argument. An isolated authenticated run with these dependencies has exercised text, source-file reads and writes, and denied writes; complete production provisioning and acceptance remain outstanding. The lockfile overrides the ACP package's older Zod patch to address a published vulnerability, so compatibility must be rechecked when upgrading.

The controller uses source tool aliases by default. For the experimental question, project-hook and shell-streaming paths, set `PAC_ENABLE_QUESTIONS=1`, `PAC_ENABLE_PROJECT_HOOKS=1` and `PAC_ENABLE_SHELL_STREAMING=1` in the controller process environment. `PAC_ENABLE_BACKGROUND=1` additionally enables the incomplete background and subagent path. Set `PAC_AGENT_RECONNECT=1` on the agent process to retry registration after disconnection; this does not replay interrupted work.

From the source workspace, set the following environment variables to the paths and values appropriate to that machine:

```text
PAC_EXPERIMENTAL=1
PAC_OPENCODE_BINARY=<absolute path to OpenCode, only if it is not on PATH>
PAC_NAME=<registered PAC name>
PAC_RELAY_URL=wss://<relay host>
PAC_SOURCE_TOKEN_FILE=<absolute path to this source's relay credential file>
PAC_CONTROLLER_CWD=<absolute working directory on the controller>
PAC_SOURCE_BASH=<absolute path to Bash, if not found automatically>
```

Then run `node <checkout>/adapters/opencode-pac.mjs` from the workspace. The launcher lists available models and asks for a selection before opening OpenCode. For non-interactive use, set `PAC_MODEL` to an available identifier such as `PAC_example/sonnet`. `PAC_SESSION_DIR` optionally changes where local session bindings and uncertain-turn markers are stored. Do not put credentials into that directory or into the repository.

For the experimental HAPI integration, `node adapters/install-hapi-command.mjs <new-absolute-directory>` creates an `opencode` command in a new directory without replacing an existing installation. Put that directory first in the HAPI runner's `PATH`, set `PAC_OPENCODE_BINARY` to the absolute path of the real OpenCode executable, and provide the PAC settings above to the runner. ACP requests use the PAC router; version probes and other commands go to native OpenCode. The runner must use the PAC-enabled HAPI build from [the integration branch](https://github.com/3ndetz/hapi/tree/work/pac-bridge-integration). This installer does not change or restart an existing runner, configure authentication, or constitute a production deployment.

For several provisioned PACs, set `PAC_ENDPOINTS_FILE` to a JSON file containing a nonempty array. Each entry has a stable `id`, a unique `name`, a `url`, a local `tokenFile` path and a controller-side `cwd`. PAC names and model IDs select the remote runtime; they are not credentials. Protect the endpoint file and credential files using the operating system's access controls.

The launcher currently requires experimental mode and has known gaps, including background and subagent lifecycle, full tool parity, cross-platform acceptance and production service management. Existing sessions remain bound to the selected PAC and workspace; switching models within that PAC is experimental. An interrupted operation can have an unknown outcome; the bridge blocks automatic replay and requires reconciliation. Selecting a different PAC or workspace requires a new session. Do not treat the launcher as a replacement for the complete delivery and acceptance in [REQUIREMENTS.md](REQUIREMENTS.md).

Image capability is not yet discovered from PAC model catalogs. `PAC_EXPERIMENTAL_IMAGE_INPUT=1` advertises image input for every model in the launcher and should only be used with models known to support it. Without that setting the plugin rejects a PAC image attachment rather than silently omitting it. The current provider also enforces a 1 MiB request body limit. One isolated authenticated Claude test accepted a small PNG attachment, and synthetic tests verify image forwarding; larger and varied images and model-specific capability discovery remain unverified.
