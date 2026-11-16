import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const executable = fileURLToPath(new URL('../scripts/verify-windows-pac-models.mjs', import.meta.url))

async function scenario(mode) {
  const home = await mkdtemp(join(tmpdir(), 'pac-matrix-fixture-'))
  const profile = join(home, '.hapi-servermall')
  await mkdir(profile)
  let workspace, archived = false
  const messages = []
  const server = http.createServer(async (req, res) => {
    const body = []
    for await (const chunk of req) body.push(chunk)
    const data = body.length ? JSON.parse(Buffer.concat(body).toString()) : {}
    const reply = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (req.url === '/api/auth') return reply(200, { token: 'test-token' })
    if (req.url === '/api/machines') return reply(200, { machines: [{ id: 'test-machine', active: true }] })
    if (req.url.startsWith('/api/machines/test-machine/opencode-models?')) return reply(200, { availableModels: [{ modelId: 'PAC_test/model', name: 'PAC test' }] })
    if (req.url === '/api/machines/test-machine/spawn') {
      workspace = data.directory
      if (mode === 'uncertain-spawn') return reply(502, {})
      await writeFile(join(workspace, 'launcher-proof.log'), 'acp\n')
      return reply(200, { type: 'success', sessionId: 'test-session' })
    }
    if (req.url.startsWith('/api/sessions/test-session/messages') && req.method === 'GET') return reply(200, { messages })
    if (req.url === '/api/sessions/test-session/messages' && req.method === 'POST') {
      const marker = data.text.match(/PAC_MODEL_MATRIX_[A-Za-z0-9_]+/)[0]
      messages.push({ id: 'agent-message', content: { role: 'agent', content: { data: { type: 'message', message: marker } } } })
      return reply(200, {})
    }
    if (req.url === '/api/sessions/test-session/archive') { archived = ['success', 'archived-active'].includes(mode); return reply(archived ? 200 : 409, {}) }
    if (req.url === '/api/sessions/test-session') return reply(200, { session: { active: mode === 'archived-active', metadata: { lifecycleState: archived ? 'archived' : 'running' } } })
    return reply(404, {})
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ machineId: 'test-machine', cliApiToken: 'test-only' }))
  await writeFile(join(profile, 'connection.json'), JSON.stringify({ relayPort: server.address().port }))
  try {
    const child = spawn(process.execPath, [executable], { env: { ...process.env, USERPROFILE: home, PAC_TEST_INSTALLED: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk.toString() }); child.stderr.on('data', chunk => { stderr += chunk.toString() })
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) })
    const directories = await readdir(join(home, 'sma-test'))
    return { code, directories, archived, stdout, stderr }
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    const parent = await realpath(tmpdir()), actual = await realpath(home), child = relative(parent, actual)
    if (isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`) || !/^pac-matrix-fixture-[A-Za-z0-9]+$/.test(child)) throw Error('Refusing to remove an unexpected fixture directory')
    await rm(actual, { recursive: true, force: true })
  }
}

test('model check retains its workspace after archive pending process verification', { skip: process.platform !== 'win32' }, async () => {
  const result = await scenario('success')
  assert.equal(result.code, 1, result.stderr); assert.equal(result.directories.length, 1); assert.equal(result.archived, true); assert.match(result.stderr, /retained pending ownership-safe process verification/)
})

test('model check preserves its workspace if archive is uncertain', { skip: process.platform !== 'win32' }, async () => {
  const result = await scenario('uncertain-archive')
  assert.equal(result.code, 1, result.stderr); assert.equal(result.archived, false); assert.equal(result.directories.length, 1)
})

test('model check preserves its workspace if spawn outcome is uncertain', { skip: process.platform !== 'win32' }, async () => {
  const result = await scenario('uncertain-spawn')
  assert.equal(result.code, 1, result.stderr); assert.equal(result.directories.length, 1)
})

test('model check does not confirm an archived session that remains active', { skip: process.platform !== 'win32' }, async () => {
  const result = await scenario('archived-active')
  assert.equal(result.code, 1, result.stderr); assert.equal(result.directories.length, 1)
  assert.match(result.stdout, /\"stage\":\"cleanup\",\"archived\":false/)
})
