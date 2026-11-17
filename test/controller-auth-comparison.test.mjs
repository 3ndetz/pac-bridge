import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { captureComparison, compareCaptures, currentPrincipal } from './fixtures/controller-auth-comparison.mjs'

test('comparison records equality without identity, paths, model or credential values', async () => {
  const key = randomBytes(32), principal = await currentPrincipal()
  const env = { HOME: 'C:\\Synthetic-private-home', CLAUDE_CONFIG_DIR: 'C:\\Synthetic-private-config', ANTHROPIC_API_KEY: 'synthetic-private-credential', ANTHROPIC_AUTH_TOKEN: '' }
  const first = captureComparison({ key, principal, env, sdkModel: 'synthetic-private-model', route: 'local-mock' })
  const second = captureComparison({ key, principal, env: { ...env, HOME: 'c:\\SYNTHETIC-private-home', ANTHROPIC_API_KEY: 'other-private-credential' }, sdkModel: 'synthetic-private-model', route: 'local-mock' })
  const result = compareCaptures(first, second)
  assert.equal(result.principal, principal ? true : null)
  assert.equal(result.homes.HOME, true)
  assert.equal(result.homes.USERPROFILE, null)
  assert.equal(result.presence.ANTHROPIC_API_KEY, true)
  assert.equal(first.presence.ANTHROPIC_AUTH_TOKEN, true)
  assert.equal(result.sdkModel, true)
  assert.equal(result.route, true)
  assert.doesNotMatch(JSON.stringify([first, second, result]), /synthetic-private|other-private/i)
})

test('missing and different values remain distinguishable without claiming unknown equality', () => {
  const key = randomBytes(32)
  const a = captureComparison({ key, principal: 'sid:one', env: { HOME:'C:\\one', ANTHROPIC_AUTH_TOKEN:'x' }, sdkModel:'one', route:'remote-relay' })
  const b = captureComparison({ key, principal: 'sid:two', env: { HOME:'C:\\two' }, sdkModel:'two', route:'local-mock' })
  const result = compareCaptures(a, b)
  assert.equal(result.principal, false)
  assert.equal(result.homes.HOME, false)
  assert.equal(result.homes.CLAUDE_CONFIG_DIR, null)
  assert.equal(result.presence.ANTHROPIC_AUTH_TOKEN, false)
  assert.equal(result.sdkModel, false)
  assert.equal(result.route, false)
  assert.throws(() => captureComparison({ key:Buffer.alloc(1), env:{} }), /key required/)
  assert.throws(() => compareCaptures(a, captureComparison({ key:randomBytes(32), env:{}, route:'local-mock' })), /keys differ/)
})
