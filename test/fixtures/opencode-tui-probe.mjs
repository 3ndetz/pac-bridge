import { once } from 'node:events'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { attachAcpRelay } from '../../src/acp-relay.mjs'
import { startAgent } from '../../src/acp-transport.mjs'
import { spawnContained, stopContained } from '../../src/spawn-contained.mjs'

if (!process.env.PAC_OPENCODE_BINARY) throw new Error('PAC_OPENCODE_BINARY is required')
const root = await mkdtemp(join(tmpdir(), 'pac-opencode-tui-'))
const server = createServer()
const relay = attachAcpRelay(server, { authorize: () => true })
let agent, child
try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `ws://127.0.0.1:${server.address().port}`
  const fake = fileURLToPath(new URL('./fake-acp-agent.mjs', import.meta.url))
  const launcher = fileURLToPath(new URL('../../adapters/opencode-pac.mjs', import.meta.url))
  agent = await startAgent({ url, name: 'testpac', token: 'test-token', command: process.execPath, args: [fake, '--permission-response'] })
  const tokenFile = join(root, 'token')
  await writeFile(tokenFile, 'test-token')
  const env = { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD',
    SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC, TEMP: root, TMP: root,
    HOME: root, USERPROFILE: root, APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'),
    XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
    OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    PAC_EXPERIMENTAL: '1', PAC_OPENCODE_BINARY: process.env.PAC_OPENCODE_BINARY, PAC_MODEL: 'PAC_testpac/sonnet',
    PAC_RELAY_URL: url, PAC_NAME: 'testpac', PAC_SOURCE_TOKEN_FILE: tokenFile, PAC_CONTROLLER_CWD: root }
  child = spawnContained(process.execPath, [launcher, '--prompt', 'Request the test permission'], { cwd: root, env, stdio: 'inherit', windowsHide: false, interactive: true })
  const [code] = await once(child, 'close')
  process.exitCode = code ?? 1
} finally {
  if (child && child.exitCode === null) stopContained(child)
  agent?.close(); relay.close(); server.close()
  const actual = await realpath(root)
  const local = relative(await realpath(tmpdir()), actual)
  if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-opencode-tui-')) await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
