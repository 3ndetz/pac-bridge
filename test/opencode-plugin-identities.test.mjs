import assert from 'node:assert/strict'
import test from 'node:test'
import pluginFactory from '../adapters/opencode-plugin.mjs'

test('tags only the configured PAC providers', async () => {
  const previous = process.env.PAC_NAMED_PROVIDER_IDS
  process.env.PAC_NAMED_PROVIDER_IDS = JSON.stringify(['PAC_allowed'])
  try {
    const plugin = await pluginFactory()
    const input = { sessionID: 'session', message: { id: 'message' } }
    const allowed = { headers: {} }
    await plugin['chat.headers']({ ...input, model: { providerID: 'PAC_allowed' } }, allowed)
    assert.deepEqual(allowed.headers, { 'x-pac-session-id': 'session', 'x-pac-message-id': 'message', 'x-pac-provider-id': 'PAC_allowed' })
    const unrelated = { headers: {} }
    await plugin['chat.headers']({ ...input, model: { providerID: 'PAC_unrelated' } }, unrelated)
    assert.deepEqual(unrelated.headers, {})
  } finally {
    if (previous === undefined) delete process.env.PAC_NAMED_PROVIDER_IDS
    else process.env.PAC_NAMED_PROVIDER_IDS = previous
  }
})
