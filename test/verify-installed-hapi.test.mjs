import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const executable = fileURLToPath(new URL('../scripts/verify-installed-hapi.mjs', import.meta.url))

async function scenario(mode) {
  const root = await mkdtemp(join(tmpdir(), 'pac-installed-test-'))
  const profile = join(root, 'profile')
  await mkdir(profile)
  const messages = []
  let marker, archived = false
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const data = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    const reply = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
    if (request.url === '/api/auth') return reply(200, { token: 'fixture-token' })
    if (request.url === '/api/machines') return reply(200, { machines: [{ id: 'fixture-machine', active: true }] })
    if (request.url.startsWith('/api/machines/fixture-machine/opencode-models?')) return reply(200, { availableModels: [{ modelId: 'PAC_test/sonnet' }] })
    if (request.url === '/api/machines/fixture-machine/spawn') return reply(200, { type: 'success', sessionId: 'fixture-session' })
    if (request.url.startsWith('/api/sessions/fixture-session/messages') && request.method === 'GET') return reply(200, { messages })
    if (request.url === '/api/sessions/fixture-session/messages' && request.method === 'POST') {
      marker = data.text.match(/PAC_BRIDGE_PROOF_[\w-]+/)?.[0] || marker
      const content = data.text === '/compact' ? { type: 'compact-summary' } : { type: 'message', message: data.text.startsWith('Remember') ? 'READY' : marker }
      messages.push({ id: String(messages.length), content: { role: 'agent', content: { data: content } } })
      return reply(200, {})
    }
    if (request.url === '/api/sessions/fixture-session/archive') { archived = mode !== 'unconfirmed'; return reply(mode === 'lost-response' ? 500 : 200, {}) }
    if (request.url === '/api/sessions/fixture-session') return reply(200, { session: { active: mode === 'archived-active' ? true : false, metadata: { lifecycleState: archived ? 'archived' : 'running' } } })
    return reply(404, {})
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ machineId: 'fixture-machine', cliApiToken: 'fixture-token' }))
  await writeFile(join(profile, 'connection.json'), JSON.stringify({ relayPort: server.address().port }))
  try {
    const child = spawn(process.execPath, [executable, root, 'PAC_test/sonnet'], { env: { ...process.env, HAPI_HOME: profile, PAC_TEST_INSTALLED: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk.toString() })
    child.stderr.on('data', chunk => { output += chunk.toString() })
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) })
    return { code, output }
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    const actual = await realpath(root), local = relative(await realpath(tmpdir()), actual)
    if (!local || isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`) || !local.startsWith('pac-installed-test-')) throw new Error('Refusing to remove an unexpected fixture directory')
    await rm(actual, { recursive: true, force: true })
  }
}

test('confirms archive after an unsuccessful archive response', async () => {
  const result = await scenario('lost-response')
  assert.equal(result.code, 0, result.output)
  assert.match(result.output, /"archived":true,"archiveStatus":"500"/)
})

test('reports the session when archive is not confirmed', async () => {
  const result = await scenario('unconfirmed')
  assert.equal(result.code, 1, result.output)
  assert.match(result.output, /archive is unconfirmed; inspect session fixture-session/)
})

test('does not confirm archive while the session remains active', async () => {
  const result = await scenario('archived-active')
  assert.equal(result.code, 1, result.output)
  assert.match(result.output, /archive is unconfirmed; inspect session fixture-session/)
})
