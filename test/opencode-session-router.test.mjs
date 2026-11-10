import assert from 'node:assert/strict'
import test from 'node:test'
import { createOpencodeSessionRouter } from '../src/opencode-session-router.mjs'

function deferred() {
  let resolve, reject
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}
const binding = { sessionId: 'session-a', model: 'PAC_work/sonnet', cwd: '/workspace' }

test('binds each OpenCode session to its PAC and forwards updates', async () => {
  const opened = []
  const closed = []
  const router = createOpencodeSessionRouter({ openSession: async (options) => {
    opened.push(options)
    return { prompt: async (prompt, update) => { update({ text: options.sessionId }); return prompt },
      cancel() {}, close() { closed.push(options.sessionId) } }
  } })
  const updates = []
  assert.deepEqual(await router.prompt(binding, [{ text: 'hi' }], (update) => updates.push(update)), [{ text: 'hi' }])
  await router.prompt(binding, [], () => {})
  await router.prompt({ ...binding, sessionId: 'session-b', model: 'PAC_other/opus' }, [], (update) => updates.push(update))
  assert.equal(opened.length, 2)
  assert.deepEqual(updates, [{ text: 'session-a' }, { text: 'session-b' }])
  await assert.rejects(router.prompt({ ...binding, model: 'PAC_other/opus' }, [], () => {}), /start a new session/)
  await assert.rejects(router.prompt({ ...binding, cwd: '/another' }, [], () => {}), /start a new session/)
  router.close()
  assert.deepEqual(closed.sort(), ['session-a', 'session-b'])
})

test('rejects concurrent turns and sends cancellation only to their owner', async () => {
  const pending = deferred()
  const entered = deferred()
  let cancellations = 0
  const router = createOpencodeSessionRouter({ openSession: async () => ({
    prompt: async () => { entered.resolve(); return pending.promise },
    cancel: async () => { cancellations++ }, close() {}
  }) })
  const first = router.prompt(binding, [], () => {})
  await entered.promise
  await assert.rejects(router.prompt(binding, [], () => {}), /already running/)
  assert.equal(await router.cancel('session-b'), false)
  assert.equal(await router.cancel('session-a'), true)
  assert.equal(cancellations, 1)
  pending.resolve({ stopReason: 'cancelled' })
  await first
  router.close()
})

test('never silently retries a failed open or a turn with an uncertain outcome', async () => {
  let opens = 0, calls = 0
  const router = createOpencodeSessionRouter({ openSession: async ({ sessionId }) => {
    opens++
    if (sessionId === 'open-failure') throw new Error('connection lost')
    return { prompt: async () => { calls++; throw new Error('connection lost after write') }, cancel() {}, close() {} }
  } })
  const failed = { ...binding, sessionId: 'open-failure' }
  await assert.rejects(router.prompt(failed, [], () => {}), /connection lost/)
  await assert.rejects(router.prompt(failed, [], () => {}), /uncertain/)
  await assert.rejects(router.prompt(binding, [], () => {}), /connection lost after write/)
  await assert.rejects(router.prompt(binding, [], () => {}), /uncertain/)
  assert.equal(opens, 2)
  assert.equal(calls, 1)
  router.close()
})

test('closes an ACP session that finishes opening after shutdown', async () => {
  const pending = deferred()
  let closed = 0
  const router = createOpencodeSessionRouter({ openSession: () => pending.promise })
  const attempt = router.prompt(binding, [], () => {})
  await Promise.resolve()
  router.close()
  pending.resolve({ prompt() {}, cancel() {}, close() { closed++ } })
  await assert.rejects(attempt, /closed/)
  assert.equal(closed, 1)
})

test('does not start a remote prompt after cancellation during session setup', async () => {
  const pending = deferred()
  const controller = new AbortController()
  let calls = 0
  const router = createOpencodeSessionRouter({ openSession: () => pending.promise })
  const attempt = router.prompt(binding, [], () => {}, { signal: controller.signal })
  await Promise.resolve()
  controller.abort()
  pending.resolve({ prompt() { calls++ }, cancel() {}, close() {} })
  await assert.rejects(attempt, /cancelled before it started/)
  assert.equal(calls, 0)
  router.close()
})

test('restores the original ACP identity and rejects mismatched persisted bindings', async () => {
  const records = new Map()
  const store = { read: async (id) => records.get(id) || null, write: async (record) => records.set(record.sessionId, record) }
  const opens = []
  const openSession = async (options) => {
    opens.push(options)
    return { sourceSessionId: 'acp-original', prompt: async () => ({}), cancel() {}, close() {} }
  }
  const first = createOpencodeSessionRouter({ openSession, store })
  await first.prompt(binding, [], () => {})
  first.close()
  const second = createOpencodeSessionRouter({ openSession, store })
  assert.equal(await second.canResume(binding.sessionId), true)
  await second.prompt(binding, [], () => {}, { mustResume: true })
  assert.equal(opens[1].resumeSessionId, 'acp-original')
  second.close()
  const third = createOpencodeSessionRouter({ openSession, store })
  await assert.rejects(third.prompt({ ...binding, model: 'PAC_other/opus' }, [], () => {}, { mustResume: true }), /does not match/)
  await assert.rejects(third.prompt({ ...binding, sessionId: 'missing' }, [], () => {}, { mustResume: true }), /binding is unavailable/)
  assert.equal(opens.length, 2)
  third.close()
})

test('switches models only within the same PAC and persists the selection across resume', async () => {
  const records = new Map(), selections = [], opens = []
  const store = { read: async (id) => records.get(id) || null, write: async (record) => records.set(record.sessionId, record) }
  const openSession = async (options) => {
    opens.push(options)
    return { sourceSessionId: 'acp-original', selectModel: async (model) => selections.push(model),
      prompt: async () => ({ stopReason: 'end_turn' }), cancel() {}, close() {} }
  }
  const router = createOpencodeSessionRouter({ openSession, store })
  await router.prompt(binding, [], () => {})
  const changed = { ...binding, model: 'PAC_work/opus' }
  await router.prompt(changed, [], () => {})
  assert.deepEqual(selections, ['PAC_work/opus'])
  assert.equal(records.get(binding.sessionId).model, 'PAC_work/opus')
  await assert.rejects(router.prompt({ ...binding, model: 'PAC_other/opus' }, [], () => {}), /start a new session/)
  router.close()
  const resumed = createOpencodeSessionRouter({ openSession, store })
  await resumed.prompt(changed, [], () => {}, { mustResume: true })
  assert.equal(opens[1].resumeSessionId, 'acp-original')
  assert.equal(opens[1].model, 'PAC_work/opus')
  resumed.close()
})

test('does not start another turn while a model change is pending', async () => {
  const pending = deferred(), entered = deferred()
  let prompts = 0
  const router = createOpencodeSessionRouter({ openSession: async () => ({
    selectModel: async () => { entered.resolve(); await pending.promise },
    prompt: async () => { prompts++; return { stopReason: 'end_turn' } }, cancel() {}, close() {},
  }) })
  await router.prompt(binding, [], () => {})
  const changing = router.prompt({ ...binding, model: 'PAC_work/opus' }, [], () => {})
  await entered.promise
  await assert.rejects(router.prompt(binding, [], () => {}), /already running/)
  pending.resolve()
  await changing
  assert.equal(prompts, 2)
  router.close()
})
