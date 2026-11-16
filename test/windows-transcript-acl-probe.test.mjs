import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import { access, mkdtemp, readdir, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const windows = process.platform === 'win32'
const script = fileURLToPath(new URL('./fixtures/windows-transcript-acl-probe.ps1', import.meta.url))
const args = (root, mode) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Root', root, '-Mode', mode]
const env = { ...process.env, PAC_TEST_WINDOWS_TRANSCRIPT_ACL: '1' }

async function removeOwnedRoot(root) {
  const actual = await realpath(root)
  const local = relative(await realpath(tmpdir()), actual)
  if (!local || isAbsolute(local) || local === '..' || local.startsWith('..' + sep) ||
      (!local.startsWith('pac-acl-probe-') && !local.startsWith('pac-acl-race-') && !local.startsWith('pac-acl-crash-'))) {
    throw new Error('Refusing unexpected test cleanup path')
  }
  await rm(actual, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 })
}

test('Windows synthetic ACL probe rejects broad access and reparse roots', { skip: !windows, timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-acl-probe-'))
  const link = join(root, 'link')
  try {
    const run = (path, mode, variables = env) => spawnSync('powershell.exe', args(path, mode), { env: variables, encoding: 'utf8', timeout: 10000 })
    const disabled = run(root, 'normal', { ...env, PAC_TEST_WINDOWS_TRANSCRIPT_ACL: '0' })
    assert.notEqual(disabled.status, 0)
    const normal = run(root, 'normal')
    assert.equal(normal.status, 0, normal.stderr)
    assert.match(normal.stdout, /OK/)
    const insecure = run(root, 'insecure')
    assert.notEqual(insecure.status, 0)
    assert.match(insecure.stderr, /ACL is not private/)
    const policies = run(root, 'policies')
    assert.equal(policies.status, 0, policies.stderr)
    assert.match(policies.stdout, /POLICIES_OK/)
    await symlink(root, link, 'junction')
    const reparse = run(link, 'normal')
    assert.notEqual(reparse.status, 0)
    assert.match(reparse.stderr, /Reparse point rejected/)
  } finally {
    try { await unlink(link) } catch (error) { if (error.code !== 'ENOENT') throw error }
    await removeOwnedRoot(root)
  }
})

test('Windows handle resists an ancestor rename attempt and concurrent writes', { skip: !windows, timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-acl-race-'))
  try {
    const result = spawnSync('powershell.exe', args(root, 'race'), { env, encoding: 'utf8', timeout: 20000 })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /OK/)
    assert.match(result.stdout, /RENAME_(BLOCKED|REPLACED)/)
    assert.deepEqual(await readdir(root), [])
  } finally { await removeOwnedRoot(root) }
})

test('Windows read-only sharing blocks replacement of an open synthetic transcript', { skip: !windows, timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-acl-race-'))
  try {
    const result = spawnSync('powershell.exe', args(root, 'protected-race'), { env, encoding: 'utf8', timeout: 20000 })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /RENAME_BLOCKED/)
    assert.match(result.stdout, /READ_OK/)
    assert.match(result.stdout, /OK/)
    assert.deepEqual(await readdir(root), [])
  } finally { await removeOwnedRoot(root) }
})

test('Windows reports whether an open file protects higher ancestors', { skip: !windows, timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-acl-race-'))
  try {
    const result = spawnSync('powershell.exe', args(root, 'ancestor-race'), { env, encoding: 'utf8', timeout: 20000 })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /ANCESTOR_(BLOCKED|RENAMED)/)
    assert.match(result.stdout, /OK/)
    assert.deepEqual(await readdir(root), [])
    console.log(result.stdout.match(/ANCESTOR_(?:BLOCKED|RENAMED)/)[0])
  } finally { await removeOwnedRoot(root) }
})

test('Windows removes the synthetic file when its owner exits without cleanup', { skip: !windows, timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-acl-crash-'))
  let exited = false
  try {
    const child = spawn('powershell.exe', args(root, 'self-exit'), { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errors = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { errors += chunk })
    const [code] = await once(child, 'close')
    exited = true
    assert.equal(code, 23, errors)
    const dir = output.match(/READY ([^\r\n]+)/)?.[1]
    assert.ok(dir && resolve(dir).toLowerCase().startsWith(resolve(await realpath(root)).toLowerCase() + sep))
    await assert.rejects(access(join(dir, 'synthetic.jsonl')), { code: 'ENOENT' })
    assert.deepEqual(await readdir(dir), [])
  } finally {
    if (exited) await removeOwnedRoot(root)
  }
})

test('Windows deletes the synthetic transcript when its owned job is terminated', { skip: !windows, timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-acl-crash-'))
  const nonce = randomBytes(16).toString('hex')
  const host = fileURLToPath(new URL('./fixtures/windows-test-owned-job-host.ps1', import.meta.url))
  const spec = Buffer.from(JSON.stringify({ command: 'powershell.exe', args: args(root, 'crash'), cwd: root, nonce, deadlineMs: 30000 })).toString('base64')
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', host, spec], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  child.stderr.resume()
  const exited = once(child, 'close')
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  const waitFor = (promise, ms) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned job deadline exceeded')), ms) })]).finally(() => clearTimeout(timer)) }
  let confirmed = false
  try {
    assert.equal((await waitFor(lines.next(), 20000)).value, `OWNED_READY ${nonce}`)
    let dir
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const entries = await readdir(root, { withFileTypes: true })
      const directories = entries.filter(entry => entry.isDirectory() && /^[a-f0-9]{32}$/.test(entry.name))
      if (directories.length === 1) {
        const candidate = join(root, directories[0].name)
        try { await access(join(candidate, 'synthetic.jsonl')); dir = candidate; break } catch (error) { if (error.code !== 'ENOENT') throw error }
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 100))
    }
    assert.ok(dir, 'Synthetic transcript did not become ready')
    await writeFile(join(root, 'stop.tmp'), nonce, { flag: 'wx' })
    await rename(join(root, 'stop.tmp'), join(root, 'stop.signal'))
    assert.equal((await waitFor(lines.next(), 20000)).value, `OWNED_CLOSED ${nonce}`)
    assert.equal((await waitFor(exited, 10000))[0], 0)
    confirmed = true
    await assert.rejects(access(join(dir, 'synthetic.jsonl')), { code: 'ENOENT' })
    assert.deepEqual(await readdir(dir), [])
  } finally {
    if (confirmed) await removeOwnedRoot(root)
  }
})
