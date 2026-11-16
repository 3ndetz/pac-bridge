import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordMcpAudit } from './fixtures/mcp-audit.mjs'

test('MCP audit creation never overwrites an existing file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-audit-test-'))
  try {
    const file = join(root, 'audit')
    await writeFile(file, 'sentinel')
    await assert.rejects(recordMcpAudit(file), { code: 'EEXIST' })
    assert.equal(await readFile(file, 'utf8'), 'sentinel')
    const fresh = join(root, 'fresh')
    await recordMcpAudit(fresh)
    assert.equal(await readFile(fresh, 'utf8'), 'called')
  } finally {
    await rm(join(root, 'audit'), { force: true })
    await rm(join(root, 'fresh'), { force: true })
    await rmdir(root)
  }
})
