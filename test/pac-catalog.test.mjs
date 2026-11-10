import assert from 'node:assert/strict'
import test from 'node:test'
import { PacCatalog } from '../src/pac-catalog.mjs'

test('resolves a model only for the authorized, online named PAC', () => {
  const catalog = new PacCatalog()
  catalog.register({ id: 'first', name: 'workstation', models: [{ id: 'sonnet', name: 'Sonnet' }] })
  catalog.register({ id: 'second', name: 'laptop', models: [{ id: 'opus', name: 'Opus' }] })
  const allowed = new Set(['first'])
  assert.deepEqual(catalog.resolve('PAC_workstation/sonnet', allowed), { pacId: 'first', pacName: 'workstation', modelId: 'sonnet' })
  assert.equal(catalog.list(allowed).length, 1)
  assert.throws(() => catalog.resolve('PAC_laptop/opus', allowed), /unavailable or unauthorized/)
  catalog.register({ id: 'first', name: 'workstation', models: [{ id: 'sonnet', name: 'Sonnet' }], online: false })
  assert.throws(() => catalog.resolve('PAC_workstation/sonnet', allowed), /unavailable or unauthorized/)
})

test('rejects ambiguous PAC names and duplicate models without replacing existing entries', () => {
  const catalog = new PacCatalog()
  catalog.register({ id: 'first', name: 'one', models: [{ id: 'model', name: 'Model' }] })
  assert.throws(() => catalog.register({ id: 'second', name: 'ONE', models: [] }), /already registered/)
  assert.throws(() => catalog.register({ id: 'first', name: 'one', models: [{ id: 'x', name: 'X' }, { id: 'x', name: 'X' }] }), /duplicate/)
  assert.equal(catalog.resolve('PAC_one/model', new Set(['first'])).pacId, 'first')
  assert.throws(() => catalog.list(), /authorization/)
})

test('renames a PAC without changing its identity or accepting its stale selector', () => {
  const catalog = new PacCatalog()
  const authorized = new Set(['stable-id'])
  catalog.register({ id: 'stable-id', name: 'old-name', models: [{ id: 'sonnet', name: 'Sonnet' }] })
  catalog.register({ id: 'stable-id', name: 'new-name', models: [{ id: 'sonnet', name: 'Sonnet' }] })
  assert.throws(() => catalog.resolve('PAC_old-name/sonnet', authorized), /unavailable or unauthorized/)
  assert.deepEqual(catalog.resolve('PAC_new-name/sonnet', authorized), { pacId: 'stable-id', pacName: 'new-name', modelId: 'sonnet' })
})
