import { randomUUID } from 'node:crypto'
import { Transform } from 'node:stream'
import { normalizePacBackgroundTasks } from './pac-background-tasks.mjs'

export function createOpencodeAcpProxy({ input, output, childInput, childOutput, providerUrl, token, maxLineBytes = 16 * 1024 * 1024, maxTracked = 4096, maxStops = 32, timeoutMs = 30000, onFatal = () => {}, onSnapshotReady }) {
  const sessions = new Set(), openings = new Map(), prompts = new Map(), stops = new Set(), seenStops = new Set(), snapshots = new Set()
  let closed = false
  const valid = x => typeof x === 'string' && x.length > 0 && x.length <= 512 && !/[\s\x00-\x1f\x7f]/.test(x)
  const key = id => JSON.stringify([typeof id, id])
  function fail(error) {
    if (closed) return
    closed = true
    input.unpipe(inbound); input.pause(); childOutput.unpipe(outbound)
    inbound.destroy(); outbound.destroy(); childInput.destroy(); childOutput.destroy()
    if (error) input.destroy()
    if (error) onFatal(new Error('ACP proxy transport or framing failure'))
  }
  function send(message) {
    if (closed || output.destroyed || !output.writable) throw new Error('ACP proxy connection is closed')
    const raw = Buffer.from(JSON.stringify(message) + '\n')
    if (raw.length > maxLineBytes || output.writableLength + raw.length > maxLineBytes) throw new Error('ACP proxy output limit reached')
    if (!output.write(raw)) {
      input.pause()
      output.once('drain', () => { if (!closed) input.resume() })
    }
  }
  function reply(id, result, error) {
    if (closed || output.destroyed || !output.writable) return
    const msg = error ? { jsonrpc: '2.0', id, error: { code: -32000, message: error } } : { jsonrpc: '2.0', id, result }
    try { send(msg) } catch (error) { fail(error) }
  }
  function publishToolUpdate(sessionId, update) {
    if (!valid(sessionId) || !sessions.has(sessionId) || ![...prompts.values()].includes(sessionId) ||
        !update || !['tool_call', 'tool_call_update'].includes(update.sessionUpdate) || !valid(update.toolCallId)) {
      throw new Error('Invalid or inactive PAC tool update')
    }
    const clean = Object.fromEntries(['sessionUpdate', 'toolCallId', 'title', 'kind', 'status', 'rawInput', 'rawOutput', 'content', 'locations']
      .filter(k => Object.hasOwn(update, k)).map(k => [k, update[k]]))
    if (Buffer.byteLength(JSON.stringify(clean)) > 1024 * 1024) throw new Error('PAC tool update exceeds size limit')
    try { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: clean } }) }
    catch (error) { fail(error); throw new Error('PAC tool update delivery failed') }
  }
  function publishBackgroundTasks(sessionId, tasks) {
    if (!valid(sessionId) || !sessions.has(sessionId) || !Array.isArray(tasks) || tasks.length > 128) throw new Error('Invalid or unowned PAC background snapshot')
    const clean = normalizePacBackgroundTasks(tasks)
    try { send({ jsonrpc:'2.0', method:'pac/background_tasks_changed', params:{rootSessionId:sessionId,tasks:clean} }) }
    catch (error) { fail(error); throw new Error('PAC background snapshot delivery failed') }
  }
  function publishBackgroundAvailability(sessionId, value) {
    if (!valid(sessionId) || !sessions.has(sessionId) || !value || value.availability !== 'unknown' || (value.epoch !== null && (typeof value.epoch !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.epoch)))) throw new Error('Invalid or unowned PAC availability')
    try { send({jsonrpc:'2.0',method:'pac/background_availability',params:{rootSessionId:sessionId,epoch:value.epoch,availability:'unknown'}}) }
    catch (error) { fail(error); throw new Error('PAC availability delivery failed') }
  }
  function lineTransform(handle) {
    let pieces = [], size = 0
    return new Transform({ transform(chunk, _encoding, done) {
      try {
        let pos = 0
        while (pos < chunk.length) {
          const end = chunk.indexOf(10, pos), stop = end < 0 ? chunk.length : end + 1
          const part = chunk.subarray(pos, stop); size += part.length
          if (size > maxLineBytes) throw new Error('ACP message exceeds size limit')
          pieces.push(part); pos = stop
          if (end >= 0) {
            const raw = Buffer.concat(pieces, size); pieces = []; size = 0
            let msg; try { msg = JSON.parse(raw.toString('utf8')) } catch {}
            if (handle(msg) !== false) this.push(raw)
          }
        }
        done()
      } catch (error) { done(error) }
    }, flush(done) { if (size) done(new Error('Incomplete ACP message')); else done() } })
  }
  const inbound = lineTransform(msg => {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' || !Object.hasOwn(msg, 'id')) return
    const id = msg.id, k = key(id)
    if (msg.method === 'session/prompt' && valid(msg.params?.sessionId) && sessions.has(msg.params.sessionId)) {
      if (prompts.size >= maxTracked || prompts.has(k)) throw new Error('ACP prompt tracking limit')
      prompts.set(k, msg.params.sessionId)
    }
    if (msg.method === 'session/new' || msg.method === 'session/load') {
      if (openings.size >= maxTracked || openings.has(k)) throw new Error('ACP session tracking limit')
      openings.set(k, { method: msg.method, sessionId: msg.params?.sessionId })
    }
    if (msg.method === 'pac/background_tasks/ready' && onSnapshotReady) {
      if (!(typeof id === 'string' || Number.isSafeInteger(id)) || !valid(msg.params?.sessionId) || !sessions.has(msg.params.sessionId)) {
        reply(id, null, 'Unknown or invalid PAC session'); return false
      }
      if (snapshots.size >= maxStops || snapshots.has(k)) { reply(id, null, 'PAC snapshot capacity reached'); return false }
      snapshots.add(k)
      let timer
      Promise.race([Promise.resolve().then(() => onSnapshotReady(msg.params.sessionId)), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('snapshot timeout')), 5000) })]).then(result => {
        if (!result || result.availability !== 'unknown' || typeof result.epoch !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result.epoch)) throw new Error('Invalid snapshot state')
        reply(id, { rootSessionId: msg.params.sessionId, epoch: result.epoch, availability: 'unknown' })
      }).catch(() => reply(id, null, 'PAC background state unavailable')).finally(() => { clearTimeout(timer); snapshots.delete(k) })
      return false
    }
    if (msg.method !== 'pac/tasks/stop') return
    if (!(typeof id === 'string' || Number.isSafeInteger(id))) throw new Error('Invalid ACP stop identity')
    if (seenStops.has(k)) { reply(id, null, 'Duplicate PAC stop request; outcome may be unknown'); return false }
    if (!valid(msg.params?.sessionId) || !valid(msg.params?.taskId) || !sessions.has(msg.params.sessionId)) {
      reply(id, null, 'Unknown or invalid PAC session or task'); return false
    }
    if (stops.size >= maxStops || seenStops.size >= maxTracked) { reply(id, null, 'PAC stop capacity reached'); return false }
    seenStops.add(k); stops.add(k)
    const requestId = randomUUID()
    ;(async () => {
      try {
        const response = await fetch(`${providerUrl}/pac/tasks/stop`, { method: 'POST', signal: AbortSignal.timeout(timeoutMs),
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: msg.params.sessionId, taskId: msg.params.taskId, requestId }) })
        if (!response.ok) throw new Error('stop failed')
        let body = '', bytes = 0
        for await (const chunk of response.body) {
          bytes += chunk.length
          if (bytes > 4096) throw new Error('invalid result')
          body += Buffer.from(chunk).toString('utf8')
        }
        const data = JSON.parse(body)
        if (!['stop_requested', 'stopped', 'completed', 'failed', 'timed_out'].includes(data?.status)) throw new Error('invalid result')
        reply(id, { status: data.status })
      } catch { reply(id, null, 'PAC task stop failed or its outcome is unknown; do not retry without review') }
      finally { stops.delete(k) }
    })()
    return false
  })
  const outbound = lineTransform(msg => {
    if (!msg || msg.jsonrpc !== '2.0' || Object.hasOwn(msg, 'method') || !Object.hasOwn(msg, 'id')) return
    const k = key(msg.id)
    prompts.delete(k)
    const opening = openings.get(k)
    if (!opening) return
    openings.delete(k)
    if (Object.hasOwn(msg, 'result') && !Object.hasOwn(msg, 'error')) {
      const id = opening.method === 'session/new' ? msg.result?.sessionId : opening.sessionId
      if (valid(id)) { if (sessions.size >= maxTracked && !sessions.has(id)) throw new Error('ACP session tracking limit'); sessions.add(id) }
    }
  })
  inbound.on('error', fail); outbound.on('error', fail)
  input.on('error', fail); output.on('error', fail); childInput.on('error', fail); childOutput.on('error', fail)
  input.on('close', () => { if (!input.readableEnded) fail(new Error('input closed')) }); output.on('close', () => fail(new Error('output closed')))
  childInput.on('close', () => { if (!childInput.writableFinished) fail(new Error('child input closed')) }); childOutput.on('close', () => { if (!childOutput.readableEnded) fail(new Error('child output closed')) })
  input.pipe(inbound).pipe(childInput); childOutput.pipe(outbound).pipe(output, { end: false })
  return { publishToolUpdate, publishBackgroundTasks, publishBackgroundAvailability, close: () => fail() }
}
