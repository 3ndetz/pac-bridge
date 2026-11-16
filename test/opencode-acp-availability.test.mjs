import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { openOpencodeAcpSession } from '../src/opencode-acp-session.mjs'

test('requires a session-bound snapshot before accepting ready availability', { timeout: 15000 }, async () => {
  const fake = fileURLToPath(new URL('./fixtures/fake-acp-background-availability.mjs', import.meta.url))
  const updates = []
  const session = await openOpencodeAcpSession({ command: process.execPath, args: [fake], cwd: tmpdir(), env: process.env,
    model: 'PAC_test/sonnet', onPermission: async () => ({ outcome: { outcome: 'cancelled' } }), onBackgroundAvailability: value => updates.push(value) })
  try {
    await session.prompt([], () => {})
    assert.equal(updates[0].availability, 'unknown')
    const snapshot = await session.requestBackgroundSnapshot()
    assert.deepEqual(snapshot.tasks, [{ task_id: 'task', task_type: 'agent', description: 'working' }])
    await session.prompt([], () => {})
    assert.equal(updates[1].availability, 'ready')
    assert.equal(updates[1].rootSessionId, 'root')
  } finally { session.close() }
  assert.equal(updates.at(-1).availability, 'unknown')
})

test('revokes ready availability when a later snapshot is invalid', { timeout: 15000 }, async () => {
  const fake = fileURLToPath(new URL('./fixtures/fake-acp-background-availability.mjs', import.meta.url))
  const updates = []
  const session = await openOpencodeAcpSession({ command: process.execPath, args: [fake], cwd: tmpdir(), env: { ...process.env, PAC_TEST_BAD_SECOND_SNAPSHOT: '1' },
    model: 'PAC_test/sonnet', onPermission: async () => ({ outcome: { outcome: 'cancelled' } }), onBackgroundAvailability: value => updates.push(value) })
  try {
    assert.equal((await session.requestBackgroundSnapshot()).availability, 'ready')
    await assert.rejects(session.requestBackgroundSnapshot(), /Invalid PAC background availability/)
    assert.equal(updates.at(-1).availability, 'unknown')
    await session.prompt([], () => {})
    assert.equal(updates.at(-1).availability, 'unknown')
  } finally { session.close() }
})

for (const mode of ['PAC_TEST_BAD_SNAPSHOT', 'PAC_TEST_SNAPSHOT_RACE']) test(`rejects invalid or stale background snapshot: ${mode}`, { timeout: 15000 }, async () => {
  const fake = fileURLToPath(new URL('./fixtures/fake-acp-background-availability.mjs', import.meta.url))
  const session = await openOpencodeAcpSession({ command: process.execPath, args: [fake], cwd: tmpdir(), env: { ...process.env, [mode]: '1' },
    model: 'PAC_test/sonnet', onPermission: async () => ({ outcome: { outcome: 'cancelled' } }), onBackgroundAvailability: () => {} })
  try { await assert.rejects(session.requestBackgroundSnapshot(), /Invalid PAC background availability|changed during snapshot/) }
  finally { session.close() }
})

test('delivers a validated background snapshot while its session is idle', { timeout: 15000 }, async () => {
  const fake = fileURLToPath(new URL('./fixtures/fake-opencode-child-events.mjs', import.meta.url))
  let received
  const snapshot = new Promise(resolve => { received = resolve })
  const session = await openOpencodeAcpSession({ command: process.execPath, args: [fake], cwd: tmpdir(),
    env: { ...process.env, PAC_TEST_IDLE_BACKGROUND: '1' }, model: 'PAC_test/sonnet',
    onPermission: async () => ({ outcome: { outcome: 'cancelled' } }), onIdleBackgroundTasks: received })
  try {
    await session.prompt([], () => {})
    assert.deepEqual(await snapshot, { rootSessionId: 'root', tasks: [{ task_id: 'pac:child', task_type: 'agent', description: 'working' }] })
    const next = []
    await session.prompt([], event => next.push(event))
    assert.ok(!next.some(event => event.method === 'pac/background_tasks_changed'))
  } finally { session.close() }
})

for (const mode of ['foreign', 'invalid']) test(`rejects ${mode} idle background snapshots`, { timeout: 15000 }, async () => {
  const fake = fileURLToPath(new URL('./fixtures/fake-opencode-child-events.mjs', import.meta.url))
  const snapshots = []
  const session = await openOpencodeAcpSession({ command: process.execPath, args: [fake], cwd: tmpdir(),
    env: { ...process.env, PAC_TEST_IDLE_BACKGROUND: mode }, model: 'PAC_test/sonnet',
    onPermission: async () => ({ outcome: { outcome: 'cancelled' } }), onIdleBackgroundTasks: value => snapshots.push(value) })
  try {
    await session.prompt([], () => {})
    await new Promise(resolve => setTimeout(resolve, 500))
    await assert.rejects(session.prompt([], () => {}), /connection lost|closed/)
    assert.deepEqual(snapshots, [])
  } finally { session.close() }
})

