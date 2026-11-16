import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, realpath, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { once } from 'node:events'

const deadline = (promise, ms) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned test deadline exceeded')), ms) })]).finally(() => clearTimeout(timer)) }

test('isolated Windows synthetic MCP disconnect closes its owned job', { skip: process.platform !== 'win32', timeout: 140000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-owned-mcp-'))
  const nonce = randomBytes(16).toString('hex')
  const host = fileURLToPath(new URL('./fixtures/windows-test-owned-job-host.ps1', import.meta.url))
  const target = fileURLToPath(new URL('./source-mcp-local.test.mjs', import.meta.url))
  const runner = join(root, 'runner.cjs'), resultPath = join(root, 'result.json')
  const code = "const {spawn}=require('node:child_process');const fs=require('node:fs');const env={...process.env};delete env.NODE_TEST_CONTEXT;const child=spawn(process.execPath,['--test','--test-name-pattern=disconnect or timeout during discovery and calls fails closed',process.argv[2]],{stdio:['ignore','pipe','pipe'],windowsHide:true,env});let output='';child.stdout.on('data',x=>output=(output+x).slice(-16000));child.stderr.on('data',x=>output=(output+x).slice(-16000));child.on('close',(code,signal)=>fs.writeFileSync(process.argv[3],JSON.stringify({code,signal,output})));"
  await writeFile(runner, code, { flag: 'wx' })
  const spec = Buffer.from(JSON.stringify({ command: process.execPath, args: [runner, target, resultPath], cwd: root, nonce, deadlineMs: 120000 })).toString('base64')
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', host, spec], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  child.stderr.resume()
  const closed = once(child, 'close')
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  let confirmed = false, failure
  try {
    assert.equal((await deadline(lines.next(), 20000)).value, `OWNED_READY ${nonce}`)
    assert.equal((await deadline(lines.next(), 100000)).value, `OWNED_EARLY_EXIT ${nonce}`)
    const result = JSON.parse(await readFile(resultPath, 'utf8'))
    assert.equal(result.code, 0, result.output)
    assert.match(result.output, /disconnect or timeout during discovery and calls fails closed/)
    assert.match(result.output, /pass 1/)
  } catch (error) { failure = error }
  try {
    const controlRoot = await realpath(root)
    const source = join(controlRoot, 'stop.tmp'), destination = join(controlRoot, 'stop.signal')
    if (relative(controlRoot, source) !== 'stop.tmp' || relative(controlRoot, destination) !== 'stop.signal') throw new Error('Unexpected control paths')
    await writeFile(source, nonce, { flag: 'wx' })
    await rename(source, destination)
    assert.equal((await deadline(lines.next(), 20000)).value, `OWNED_CLOSED ${nonce}`)
    assert.equal((await deadline(closed, 10000))[0], 0)
    confirmed = true
  } finally {
    if (confirmed) {
      const actual = await realpath(root), local = relative(await realpath(tmpdir()), actual)
      if (!local || isAbsolute(local) || local === '..' || local.startsWith('..' + sep) || !local.startsWith('pac-owned-mcp-')) throw new Error('Refusing unexpected test cleanup path')
      await rm(actual, { recursive: true, force: true })
    }
  }
  if (failure) throw failure
})