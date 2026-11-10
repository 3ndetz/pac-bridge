# Experimental OpenCode connection

This describes the current development launcher for an already provisioned PAC and relay. It is not a release or a complete installation procedure. See [ACCEPTANCE.md](ACCEPTANCE.md) for verified behavior and outstanding requirements.

The source machine needs Node.js, this checkout with its npm dependencies installed, an OpenCode executable and a local Bash executable. The PAC must already be registered with the relay and have a separately authenticated Claude runtime. Remote relay connections require `wss://`; a source credential is supplied as a file and Claude credentials stay on the controller.

From the source workspace, set the following environment variables to the paths and values appropriate to that machine:

```text
PAC_EXPERIMENTAL=1
PAC_OPENCODE_BINARY=<absolute path to the OpenCode executable>
PAC_NAME=<registered PAC name>
PAC_RELAY_URL=wss://<relay host>
PAC_SOURCE_TOKEN_FILE=<absolute path to this source's relay credential file>
PAC_CONTROLLER_CWD=<absolute working directory on the controller>
PAC_SOURCE_BASH=<absolute path to Bash, if not found automatically>
```

Then run `node <checkout>/adapters/opencode-pac.mjs` from the workspace. The launcher lists available models and asks for a selection before opening OpenCode. For non-interactive use, set `PAC_MODEL` to an available identifier such as `PAC_example/sonnet`. `PAC_SESSION_DIR` optionally changes where local session bindings and uncertain-turn markers are stored. Do not put credentials into that directory or into the repository.

For several provisioned PACs, set `PAC_ENDPOINTS_FILE` to a JSON file containing a nonempty array. Each entry has a stable `id`, a unique `name`, a `url`, a local `tokenFile` path and a controller-side `cwd`. PAC names and model IDs select the remote runtime; they are not credentials. Protect the endpoint file and credential files using the operating system's access controls.

The launcher currently requires experimental mode and has known gaps, including background and subagent lifecycle, full tool parity, cross-platform acceptance and production service management. Existing sessions remain bound to the selected PAC and workspace; switching models within that PAC is experimental. An interrupted operation can have an unknown outcome; the bridge blocks automatic replay and requires reconciliation. Selecting a different PAC or workspace requires a new session. Do not treat the launcher as a replacement for the complete delivery and acceptance in [REQUIREMENTS.md](REQUIREMENTS.md).

Image capability is not yet discovered from PAC model catalogs. `PAC_EXPERIMENTAL_IMAGE_INPUT=1` advertises image input for every model in the launcher and should only be used in controlled tests with models known to support it. Without that setting the plugin rejects a PAC image attachment rather than silently omitting it. The current provider also enforces a 1 MiB request body limit; image behavior with an authenticated Claude runtime is unverified.
