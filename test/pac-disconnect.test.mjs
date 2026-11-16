import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { watchSourceDisconnect } from '../src/pac-disconnect.mjs'

test('source end and close invalidate only once in either order', () => {
  for (const events of [['end', 'close'], ['close', 'end']]) {
    const stream = new EventEmitter()
    let calls = 0
    watchSourceDisconnect(stream, () => { calls++ })
    for (const event of events) stream.emit(event)
    assert.equal(calls, 1)
  }
})
