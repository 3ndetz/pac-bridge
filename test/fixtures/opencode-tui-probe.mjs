import { once } from 'node:events'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
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
  const live = process.env.PAC_TUI_LIVE === '1'
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = live ? process.env.PAC_LIVE_URL : `ws://127.0.0.1:${server.address().port}`
  const fake = fileURLToPath(new URL('./fake-acp-agent.mjs', import.meta.url))
  const launcher = fileURLToPath(new URL('../../adapters/opencode-pac.mjs', import.meta.url))
  if (!live) agent = await startAgent({ url, name: 'testpac', token: 'test-token', command: process.execPath, args: [fake, '--permission-response'] })
  const tokenFile = live ? process.env.PAC_LIVE_SOURCE_TOKEN_FILE : join(root, 'token')
  if (!live) await writeFile(tokenFile, 'test-token')
  const env = { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD',
    SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC, TEMP: root, TMP: root,
    HOME: root, USERPROFILE: root, APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'),
    XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
    OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    PAC_EXPERIMENTAL: '1', PAC_OPENCODE_BINARY: process.env.PAC_OPENCODE_BINARY, PAC_MODEL: 'PAC_testpac/sonnet',
    NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
    PAC_EXPERIMENTAL_HOOKS: live ? '1' : '0', PAC_SOURCE_BASH: live ? join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe') : undefined,
    PAC_RELAY_URL: url, PAC_NAME: 'testpac', PAC_SOURCE_TOKEN_FILE: tokenFile, PAC_CONTROLLER_CWD: live ? process.env.PAC_LIVE_CONTROLLER_CWD : root }
  if (process.env.PAC_TEST_CHOOSE === '1') delete env.PAC_MODEL
  const prompt = live ? `Use Write to create ${join(root, 'tui-fixture.txt')} containing PAC_TUI_WRITE_OK.` : 'Request the test permission'
  child = spawnContained(process.execPath, [launcher, '--prompt', prompt], { cwd: root, env, stdio: 'inherit', windowsHide: false, interactive: true })
  const [code, signal] = await once(child, 'close')
  process.stderr.write(`TUI probe exit: ${code ?? 'none'} ${signal ?? 'none'}\n`)
  if (live) {
    let content = ''
    try { content = (await readFile(join(root, 'tui-fixture.txt'), 'utf8')).trim() } catch {}
    process.stderr.write(content === 'PAC_TUI_WRITE_OK' ? 'TUI source write verified\n' : 'TUI source write not verified\n')
  }
  process.exitCode = code ?? 1
} finally {
  if (child && child.exitCode === null) stopContained(child)
  agent?.close(); relay.close(); server.close()
  const actual = await realpath(root)
  const local = relative(await realpath(tmpdir()), actual)
  if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-opencode-tui-')) await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
