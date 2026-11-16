import test from 'node:test'
import assert from 'node:assert/strict'
import { browserWorkspaceDisposition } from './fixtures/browser-workspace-policy.mjs'

test('browser workspace is retained after a session creation attempt', () => {
  assert.equal(browserWorkspaceDisposition({ creationAttempted: true, keep: false }), 'retain-review')
  assert.equal(browserWorkspaceDisposition({ creationAttempted: true, keep: true }), 'retain-review')
  assert.equal(browserWorkspaceDisposition({ creationAttempted: undefined, keep: false }), 'retain-review')
  assert.equal(browserWorkspaceDisposition({ creationAttempted: false, keep: true }), 'retain')
  assert.equal(browserWorkspaceDisposition({ creationAttempted: false, keep: false }), 'remove')
})
