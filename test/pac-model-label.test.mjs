import assert from 'node:assert/strict'
import test from 'node:test'
import { pacModelLabel } from '../src/pac-model-label.mjs'

test('labels mixed PAC models without misidentifying their family', () => {
  const endpoint = { name: 'work', displayName: '#1', modelPrefix: 'Claude' }
  assert.equal(pacModelLabel(endpoint, { id: 'claude-opus-5-5', name: 'Opus 5.5' }), 'PAC #1 / Claude Opus 5.5')
  assert.equal(pacModelLabel(endpoint, { id: 'sonnet', name: 'Claude Sonnet' }), 'PAC #1 / Claude Sonnet')
  assert.equal(pacModelLabel(endpoint, { id: 'sonnet', name: 'Claude-Sonnet' }), 'PAC #1 / Claude-Sonnet')
  assert.equal(pacModelLabel(endpoint, { id: 'openai/gpt-5-codex', name: 'GPT-5 Codex' }), 'PAC #1 / GPT-5 Codex')
  assert.equal(pacModelLabel(endpoint, { id: 'other/model', name: 'Other Model' }), 'PAC #1 / Other Model')
  assert.equal(pacModelLabel(endpoint, { id: 'model', name: '\n\t' }), 'PAC #1 / model')
  assert.equal(pacModelLabel({ name: 'test', modelPrefix: 'Team' }, { id: 'model', name: 'Model' }), 'PAC test / Team Model')
})
