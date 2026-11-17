import assert from 'node:assert/strict'
import test from 'node:test'
import { createOpencodeSessionRouter } from '../src/opencode-session-router.mjs'
const binding = { sessionId: 'session', model: 'PAC_synthetic/sonnet', cwd: '/synthetic' }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function session(close = () => {}) { return { prompt: async () => ({ stopReason: 'end_turn' }), cancel() {}, close } }

for (const stage of ['journal', 'store']) test(`router close during ${stage} read prevents a new ACP process`, async () => {
  const entered = deferred(), release = deferred()
  let opens = 0
  const read = async () => { entered.resolve(); await release.promise; return null }
  const router = createOpencodeSessionRouter({
    ...(stage === 'journal' ? { journal: { isPending: read } } : { store: { read } }),
    openSession: async () => { opens++; return session() },
  })
  const pending = router.prompt(binding, [], () => {})
  await entered.promise
  router.close()
  release.resolve()
  await assert.rejects(pending, /closed/)
  assert.equal(opens, 0)
})

test('router close aborts an in-flight ACP opening', async () => {
  const entered = deferred(), release = deferred()
  let signal, closes = 0
  const router = createOpencodeSessionRouter({ openSession: async options => {
    signal = options.signal
    entered.resolve()
    await release.promise
    return session(() => { closes++ })
  } })
  const pending = router.prompt(binding, [], () => {})
  await entered.promise
  router.close()
  release.resolve()
  await assert.rejects(pending, /closed/)
  assert.equal(signal?.aborted, true)
  assert.equal(closes, 1)
})

test('one failed session cleanup does not leave other owned sessions running', async () => {
  const closed = []
  let failed = false
  const router = createOpencodeSessionRouter({ openSession: async ({ sessionId }) => session(() => {
    closed.push(sessionId)
    if (sessionId === 'session' && !failed) { failed = true; throw new Error('synthetic cleanup failure') }
  }) })
  await router.prompt(binding, [], () => {})
  await router.prompt({ ...binding, sessionId: 'other' }, [], () => {})
  assert.throws(() => router.close(), /cleanup/)
  assert.deepEqual(closed, ['session', 'other'])
  router.close()
  assert.deepEqual(closed, ['session', 'other', 'session'])
})
