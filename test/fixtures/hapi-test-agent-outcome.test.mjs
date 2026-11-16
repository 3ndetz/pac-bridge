import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inspectPacMessages } from './hapi-test-agent-outcome.mjs'
const item = (role,type,message) => ({content:{role,content:{data:{type,message}}}})
test('only typed agent errors stop the wait, with a safe category', () => {
  assert.equal(inspectPacMessages([item('user','error','authentication failed controller')], 'MARKER'),null)
  assert.equal(inspectPacMessages([item('agent','message','authentication failed controller')], 'MARKER'),null)
  assert.deepEqual(inspectPacMessages([item('agent','error','authentication failed controller sensitive detail')], 'MARKER'),{kind:'error',category:'authentication_related'})
  assert.deepEqual(inspectPacMessages([item('agent','error','PAC reported an authentication-related error; check the relay and controller sign-in.')], 'MARKER'),{kind:'error',category:'authentication_related'})
  assert.deepEqual(inspectPacMessages([item('agent','error','some private detail')], 'MARKER'),{kind:'error',category:'agent_error'})
})
test('prefers a typed error over a marker and recognizes the expected reply', () => {
  assert.deepEqual(inspectPacMessages([item('agent','message','MARKER'),item('agent','error','authentication failed')], 'MARKER'),{kind:'error',category:'authentication_related'})
  assert.deepEqual(inspectPacMessages([item('agent','message','MARKER')], 'MARKER'),{kind:'success'})
})
