import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
test('disabled MCP route does not load the optional SDK during router startup', async () => {
  const loader = new URL('./fixtures/reject-mcp-loader.mjs', import.meta.url).href
  const router = fileURLToPath(new URL('../adapters/pac-opencode-router.mjs', import.meta.url))
  const env = { ...process.env, PAC_EXPERIMENTAL: '', PAC_OPENCODE_BINARY: '', PAC_TEST_ROUTED_SOURCE_MCP: '' }
  delete env.NODE_OPTIONS
  delete env.NODE_EXTRA_CA_CERTS
  await assert.rejects(run(process.execPath, ['--experimental-loader', loader, router], { env, windowsHide: true }), error => {
    assert.match(error.stderr, /Incomplete experimental OpenCode router configuration/)
    assert.doesNotMatch(error.stderr, /MCP dependency was loaded/)
    return true
  })
})
