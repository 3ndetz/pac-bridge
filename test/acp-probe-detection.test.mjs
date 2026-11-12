import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { isHapiModelProbe } from '../src/acp-probe-detection.mjs'

test('identifies only the HAPI model probe and replays fragmented ACP input', async () => {
  for (const [name, version, expected] of [['hapi-opencode-models', 1, true], ['hapi', 1, false], ['hapi-opencode-models', 2, false]]) {
    const stream = new PassThrough()
    const original = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version, clientInfo: { name } } }) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/new' }) + '\n'
    const detected = isHapiModelProbe(stream)
    stream.write(original.slice(0, 17)); stream.write(original.slice(17))
    assert.equal(await detected, expected)
    assert.equal(stream.read().toString(), original)
    stream.end()
  }
})

test('bounds an incomplete initialization', async () => {
  const stream = new PassThrough()
  const detected = isHapiModelProbe(stream, 8)
  stream.write('012345678')
  await assert.rejects(detected, /size limit/)
  stream.end()
})
