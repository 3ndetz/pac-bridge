import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile, symlink, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSessionOwnershipStore, createSessionOwnership, enforceSessionOwnership } from '../src/session-ownership.mjs'

const a = 'a'.repeat(64), b = 'b'.repeat(64)
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'pac-owner-test-'))
  const directory = join(root, 'owners'), store = createSessionOwnershipStore(directory)
  try { await run({ root, directory, store, owner: createSessionOwnership({ principal: a, store }) }) }
  finally { await rm(root, { recursive: true, force: true }) }
}

test('ownership survives controller restart and denies missing or other principals', () => fixture(async ({ directory, store, owner }) => {
  await owner.claim('first')
  const restarted = createSessionOwnership({ principal: a, store: createSessionOwnershipStore(directory) })
  await restarted.assert('first')
  await assert.rejects(createSessionOwnership({ principal: b, store }).assert('first'), /access denied/)
  await assert.rejects(owner.assert('legacy-unbound'), /access denied/)
  await assert.rejects(createSessionOwnership({ store }).claim('unknown'), /access denied/)
  assert.equal(await store.owner('unknown'), null)
}))

test('concurrent claims cannot transfer ownership or overwrite an existing binding', () => fixture(async ({ store }) => {
  const results = await Promise.allSettled([store.claim('race', a), store.claim('race', b)])
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1)
  const winner = await store.owner('race')
  await store.claim('race', winner)
  await assert.rejects(store.claim('race', winner === a ? b : a), /access denied/)
  assert.equal(await store.owner('race'), winner)
}))

test('interrupted, oversized and tampered ownership records fail closed', () => fixture(async ({ directory, store }) => {
  await mkdir(directory)
  const path = join(directory, createHash('sha256').update('broken').digest('hex') + '.json')
  for (const raw of ['', '{', 'x'.repeat(5000), JSON.stringify({ version: 1, sessionId: 'other', principal: a })]) {
    await writeFile(path, raw)
    await assert.rejects(store.owner('broken'), /access denied/)
    await assert.rejects(store.claim('broken', a), /access denied/)
  }
}))

test('session IDs are data, never paths, and invalid IDs are denied', () => fixture(async ({ store, owner }) => {
  await owner.claim('../literal-session')
  await owner.assert('../literal-session')
  for (const id of [null, undefined, '', 42, 'a'.repeat(1025), 'bad\nidentity']) await assert.rejects(owner.claim(id), /access denied/)
  assert.equal(await store.owner('unbound'), null)
}))

test('ownership directory symlink is rejected', () => fixture(async ({ root, directory, store }) => {
  const outside = join(root, 'outside'); await mkdir(outside); await symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(store.claim('session', a), /access denied/)
}))

test('all SDK session methods reject another principal before invoking their implementation', () => fixture(async ({ store, owner }) => {
  await store.claim('foreign', b)
  let invoked = 0
  const methods = ['loadSession', 'resumeSession', 'prompt', 'steer', 'goal', 'stopAsyncTask', 'cancel', 'closeSession', 'deleteSession', 'setSessionMode', 'setSessionConfigOption', 'unstable_forkSession']
  const agent = { newSession: async () => ({ sessionId: 'new' }) }
  for (const name of methods) agent[name] = async () => { invoked++; return {} }
  enforceSessionOwnership(agent, owner)
  for (const name of methods) await assert.rejects(agent[name]({ sessionId: 'foreign', _meta: { sourcePrincipal: a } }), /access denied/)
  assert.equal(invoked, 0)
}))

test('new and forked sessions are bound and listings omit other owners and legacy sessions', () => fixture(async ({ store, owner }) => {
  await store.claim('foreign', b)
  const agent = {
    newSession: async () => ({ sessionId: 'new' }),
    unstable_forkSession: async () => ({ sessionId: 'fork' }),
    listSessions: async () => ({ sessions: ['new', 'foreign', 'legacy', 'fork'].map(sessionId => ({ sessionId, title: sessionId })), nextCursor: 'offset:50' }),
    loadSession: async () => ({ loaded: true }),
  }
  enforceSessionOwnership(agent, owner)
  await agent.newSession({})
  await agent.unstable_forkSession({ sessionId: 'new' })
  assert.deepEqual((await agent.listSessions({})).sessions.map(x => x.sessionId), ['new', 'fork'])
  assert.equal((await agent.listSessions({})).nextCursor, 'offset:50')
  assert.deepEqual(await agent.loadSession({ sessionId: 'fork' }), { loaded: true })
}))

test('SDK identity override options cannot redirect an authorized call to another session', () => fixture(async ({ owner }) => {
  await owner.claim('owned')
  let invoked = 0
  const agent = { newSession: async () => { invoked++; return { sessionId: 'new' } }, loadSession: async () => { invoked++ } }
  enforceSessionOwnership(agent, owner)
  for (const key of ['resume', 'continue', 'forkSession', 'sessionId', 'resumeSessionAt', 'resumeDropsTurn']) {
    const params = { sessionId: 'owned', _meta: { claudeCode: { options: { [key]: 'foreign' } } } }
    await assert.rejects(agent.newSession(params), /access denied/)
    await assert.rejects(agent.loadSession(params), /access denied/)
  }
  assert.equal(invoked, 0)
}))

test('failed durable ownership claim is not reported as a successful new session', async () => {
  const ownership = createSessionOwnership({ principal: a, store: { claim: async () => { throw new Error('synthetic persistence failure') } } })
  const agent = { newSession: async () => ({ sessionId: 'new' }) }
  enforceSessionOwnership(agent, ownership)
  await assert.rejects(agent.newSession({}), /persistence failure/)
})


test('new-session persistence failure closes the already-created SDK session before failing', async () => {
  let closed
  const ownership = createSessionOwnership({ principal: a, store: { claim: async () => { throw new Error('synthetic persistence failure') } } })
  const agent = { newSession: async () => ({ sessionId: 'new' }), closeSession: async params => { closed = params.sessionId } }
  enforceSessionOwnership(agent, ownership)
  await assert.rejects(agent.newSession({}), /persistence failure/)
  assert.equal(closed, 'new')
})
