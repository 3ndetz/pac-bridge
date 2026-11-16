import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { openOpencodeAcpSession } from '../src/opencode-acp-session.mjs'

test('reports bounded startup timing on failure without exposing the selected model', { timeout: 15000 }, async () => {
  const fake = fileURLToPath(new URL('./fixtures/fake-acp-load-history.mjs', import.meta.url))
  const diagnostics = []
  await assert.rejects(openOpencodeAcpSession({ command: process.execPath, args: [fake], cwd: tmpdir(), env: process.env,
    model: 'PAC_private/unavailable', resumeSessionId: 'saved-session', onDiagnostic: value => diagnostics.push(value),
    onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) }), /Selected PAC model is unavailable/)
  assert.ok(diagnostics.some(value => /^startup:session-new:[0-9]+ms$/.test(value)))
  assert.ok(diagnostics.every(value => !value.includes('PAC_private')))
})

