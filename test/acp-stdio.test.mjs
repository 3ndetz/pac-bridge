import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const adapter = fileURLToPath(new URL('../adapters/acp-stdio.mjs', import.meta.url))

test('forwards ACP bytes in both directions without parsing or rewriting', async () => {
  const script = 'process.stdin.pipe(process.stdout); process.stderr.write("diagnostic\\n")'
  const child = spawn(process.execPath, [adapter, process.execPath, '-e', script])
  const output = []
  const errors = []
  child.stdout.on('data', (chunk) => output.push(chunk))
  child.stderr.on('data', (chunk) => errors.push(chunk))
  const input = Buffer.from('{"jsonrpc":"2.0","method":"session/update","params":{"task":"子"}}\n{"jsonrpc":"2.0","id":1,"result":{}}\n')
  child.stdin.end(input)
  const [code] = await once(child, 'close')
  assert.equal(code, 0)
  assert.deepEqual(Buffer.concat(output), input)
  assert.equal(Buffer.concat(errors).toString(), 'diagnostic\n')
})

test('fails explicitly when the harness executable does not exist', async () => {
  const child = spawn(process.execPath, [adapter, 'pac-bridge-nonexistent-harness'])
  let errors = ''
  child.stderr.on('data', (chunk) => { errors += chunk })
  child.stdin.end()
  const [code] = await once(child, 'close')
  assert.notEqual(code, 0)
  assert.match(errors, /could not start its harness/)
})

test('initializes an installed OMP through the ACP adapter', { skip: !process.env.PAC_OMP_BIN, timeout: 30000 }, async () => {
  const child = spawn(process.execPath, [adapter, 'omp'])
  let buffer = ''
  let errors = ''
  child.stderr.on('data', (chunk) => { errors += chunk })
  try {
    const response = new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('exit', (code) => reject(new Error(`OMP exited before initialize (${code}): ${errors}`)))
      child.stdout.on('data', (chunk) => {
        buffer += chunk
        const newline = buffer.indexOf('\n')
        if (newline !== -1) {
          try { resolve(JSON.parse(buffer.slice(0, newline))) } catch (error) { reject(error) }
        }
      })
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } } }) + '\n')
    const result = await response
    assert.equal(result.id, 1)
    assert.equal(result.result?.protocolVersion, 1)
  } finally {
    child.kill()
  }
})
