import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

export function createAcpPeer(stream, { onRequest, onNotification, timeoutMs = 30000, maxLineBytes = 16 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) throw new Error('Invalid ACP message size limit')
  const pending = new Map()
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let closed = false
  let partialBytes = 0
  let notifications = Promise.resolve()
  function send(message) {
    if (closed || stream.destroyed || !stream.writable) throw new Error('ACP connection is closed')
    stream.write(JSON.stringify(message) + '\n')
  }
  function failPending() {
    if (closed) return
    closed = true
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('ACP connection lost; request outcome may be unknown')) }
    pending.clear()
  }
  lines.on('line', async (line) => {
    if (closed) return
    if (Buffer.byteLength(line, 'utf8') > maxLineBytes) { failPending(); stream.destroy(new Error('ACP message exceeds size limit')); return }
    let message
    try { message = JSON.parse(line) } catch { stream.destroy(new Error('Invalid ACP JSON')); return }
    if (!message || message.jsonrpc !== '2.0') { stream.destroy(new Error('Invalid ACP message')); return }
    if (typeof message.method !== 'string') {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) {
        const error = new Error(message.error.message || 'ACP request failed')
        error.rpc = message.error
        entry.reject(error)
      } else entry.resolve(message.result)
      return
    }
    if (message.id === undefined) {
      notifications = notifications.then(() => onNotification?.(message.method, message.params))
      notifications.catch(() => stream.destroy(new Error('ACP notification handler failed')))
      return
    }
    try {
      if (!onRequest) throw Object.assign(new Error('ACP method not supported'), { code: -32601 })
      const result = await onRequest(message.method, message.params)
      send({ jsonrpc: '2.0', id: message.id, result: result ?? null })
    } catch (error) {
      if (!closed) send({ jsonrpc: '2.0', id: message.id, error: { code: Number.isInteger(error.code) ? error.code : -32603, message: error.message } })
    }
  })
  // readline buffers an unfinished line internally. Limit it before the peer
  // can accumulate an unbounded message without sending a newline.
  stream.on('data', (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    for (const byte of bytes) {
      if (byte === 10) partialBytes = 0
      else if (++partialBytes > maxLineBytes) { failPending(); stream.destroy(new Error('ACP message exceeds size limit')); return }
    }
  })
  lines.on('close', failPending)
  lines.on('error', failPending)
  stream.on('error', failPending)
  stream.on('close', failPending)
  return {
    call(method, params, timeout = timeoutMs) {
      const id = randomUUID()
      return new Promise((resolve, reject) => {
        const timer = timeout > 0 ? setTimeout(() => { pending.delete(id); reject(new Error(`ACP request timed out: ${method}; outcome may be unknown`)) }, timeout) : null
        pending.set(id, { resolve, reject, timer })
        try { send({ jsonrpc: '2.0', id, method, params }) } catch (error) { clearTimeout(timer); pending.delete(id); reject(error) }
      })
    },
    notify(method, params) { send({ jsonrpc: '2.0', method, params }) },
    close() { failPending(); lines.close(); stream.destroy() },
  }
}
