import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { link, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, relative, sep } from 'node:path'
import test from 'node:test'
import { spawnContained, stopContained } from '../src/spawn-contained.mjs'

test('starts an OMP session through an isolated HAPI Pi runner without a model request', {
  skip: process.platform !== 'win32' || !process.env.PAC_OMP_BIN || !process.env.PAC_HAPI_BIN, timeout: 180000
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-hapi-omp-'))
  const bin = join(root, 'bin')
  const workspace = join(root, 'workspace')
  await mkdir(bin)
  await mkdir(workspace)
  await link(process.env.PAC_OMP_BIN, join(bin, 'pi.exe'))
  const reserved = createServer().listen(0, '127.0.0.1')
  await once(reserved, 'listening')
  const port = reserved.address().port
  await new Promise((resolve) => reserved.close(resolve))
  const url = `http://127.0.0.1:${port}`
  const token = randomBytes(32).toString('hex')
  const env = { PATH: bin + delimiter + process.env.PATH, PATHEXT: '.COM;.EXE;.BAT;.CMD', SystemRoot: process.env.SystemRoot, TEMP: root, TMP: root,
    USERPROFILE: root, APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'),
    PI_CODING_AGENT_DIR: join(root, 'omp'), OPENAI_API_KEY: 'pac-test-placeholder', CLI_API_TOKEN: token,
    HAPI_HOME: join(root, 'hapi'), HAPI_LISTEN_HOST: '127.0.0.1', HAPI_LISTEN_PORT: String(port),
    HAPI_PUBLIC_URL: url, HAPI_API_URL: url, HAPI_DISABLE_VERSION_HANDOFF: '1' }
  const children = []
  let jwt
  let sessionId
  function launch(args) {
    const child = spawnContained(process.env.PAC_HAPI_BIN, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.resume(); child.stderr.resume(); child.on('error', () => {})
    children.push(child)
    return child
  }
  async function request(path, options = {}) {
    const response = await fetch(url + path, { ...options, headers: { ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
      ...(options.body ? { 'content-type': 'application/json' } : {}) }, signal: options.signal ?? AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error(`HAPI HTTP ${response.status}`)
    return response.json()
  }
  async function until(action, timeout) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      try { const result = await action(); if (result) return result } catch {}
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    throw new Error('Timed out waiting for isolated HAPI state')
  }
  try {
    launch(['hub'])
    jwt = (await until(() => request('/api/auth', { method: 'POST', body: JSON.stringify({ accessToken: token }) }), 30000)).token
    assert.ok(jwt)
    launch(['runner', 'start-sync', '--workspace-root', workspace])
    const machine = await until(async () => (await request('/api/machines')).machines?.find((item) => item.active), 60000)
    const spawned = await request(`/api/machines/${machine.id}/spawn`, { method: 'POST', body: JSON.stringify({
      directory: workspace, agent: 'pi', startingMode: 'remote', yolo: true
    }) })
    assert.equal(spawned.type, 'success', JSON.stringify({ code: spawned.code, keys: Object.keys(spawned), flags:
      ['unsupported', 'unavailable', 'timeout', 'not found', 'spawn', 'model', 'permission', 'session', 'pi'].filter((word) => JSON.stringify(spawned).toLowerCase().includes(word)) }))
    sessionId = spawned.sessionId
    assert.ok(sessionId)
    const session = await until(async () => (await request(`/api/sessions/${sessionId}`)).session, 60000)
    assert.equal(session.metadata?.flavor, 'pi')
    const ready = await until(async () => {
      const current = (await request(`/api/sessions/${sessionId}`)).session
      return current?.metadata?.piSessionId ? current : null
    }, 60000)
    assert.ok(ready.metadata.piSessionId)
  } finally {
    if (jwt && sessionId) { try { await request(`/api/sessions/${sessionId}/archive`, { method: 'POST', signal: AbortSignal.timeout(10000) }) } catch {} }
    for (const child of children.reverse()) {
      const exited = child.exitCode === null ? once(child, 'close') : Promise.resolve()
      stopContained(child)
      await exited
    }
    const actual = await realpath(root)
    const local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-hapi-omp-')) await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
