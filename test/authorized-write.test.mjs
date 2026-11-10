import test from 'node:test'
import assert from 'node:assert/strict'
import { authorizedWrite } from '../src/authorized-write.mjs'

test('a late approval cannot start a cancelled workspace write', async () => {
  const controller = new AbortController()
  let approve
  let writes = 0
  const result = authorizedWrite({ signal: controller.signal, authorize: () => new Promise((resolve) => { approve = resolve }),
    connected: () => true, write: () => { writes++ } })
  controller.abort()
  approve(true)
  await assert.rejects(result, /cancelled before it started/)
  assert.equal(writes, 0)
})

test('a denied or disconnected request cannot start a workspace write', async () => {
  let writes = 0
  const signal = new AbortController().signal
  const write = () => { writes++ }
  await assert.rejects(authorizedWrite({ signal, authorize: async () => false, connected: () => true, write }), /not authorized/)
  await assert.rejects(authorizedWrite({ signal, authorize: async () => true, connected: () => false, write }), /disconnected/)
  assert.equal(writes, 0)
  assert.equal(await authorizedWrite({ signal, authorize: async () => true, connected: () => true, write: () => 'written' }), 'written')
})
