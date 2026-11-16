import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixture = fileURLToPath(new URL('./fixtures/mock-source-mcp.mjs', import.meta.url))
async function call(root) {
  const child = spawn(process.execPath, [fixture], { cwd: root, env: { ...process.env, PAC_TEST_MCP_AUDIT: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk.toString() })
  child.stderr.resume()
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_source_marker' } }) + '\n')
  assert.equal(await closed, 0)
  return JSON.parse(output.split('\n')[0])
}
test('MCP audit creation never overwrites an existing file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-audit-test-'))
  try {
    const file = join(root, 'mcp-call-audit')
    await writeFile(join(root, 'mcp-fixture.txt'), 'fixture')
    await writeFile(file, 'sentinel')
    assert.ok((await call(root)).error)
    assert.equal(await readFile(file, 'utf8'), 'sentinel')
    await rm(file)
    assert.ok((await call(root)).result)
    assert.equal(await readFile(file, 'utf8'), 'called')
  } finally {
    await rm(join(root, 'mcp-call-audit'), { force: true })
    await rm(join(root, 'mcp-fixture.txt'), { force: true })
    await rmdir(root)
  }
})
