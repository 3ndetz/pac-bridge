import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'

const namePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const channelPattern = /^[0-9a-f-]{36}$/

export function attachAcpRelay(server, { authorize, openTimeoutMs = 15000, maxBufferedBytes = 8 * 1024 * 1024, maxPending = 128 } = {}) {
  if (typeof authorize !== 'function' || !Number.isSafeInteger(maxPending) || maxPending < 1 ||
      !Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 1 || !Number.isSafeInteger(openTimeoutMs) || openTimeoutMs < 1) {
    throw new Error('Invalid relay configuration')
  }
  const websocket = new WebSocketServer({ noServer: true, maxPayload: maxBufferedBytes })
  const agents = new Map()
  const activeByRegistration = new Map()
  const pending = new Map()

  function reject(socket, status) {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
  }

  function cleanupPending(channel) {
    const entry = pending.get(channel)
    if (entry) clearTimeout(entry.timer)
    pending.delete(channel)
    return entry
  }

  function disconnect(ws, reason) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1011, reason)
  }

  function forward(from, to) {
    from.on('message', (data, binary) => {
      if (to.readyState !== WebSocket.OPEN || to.bufferedAmount + data.length > maxBufferedBytes) {
        disconnect(from, 'relay unavailable')
        disconnect(to, 'relay unavailable')
        return
      }
      to.send(data, { binary }, (error) => {
        if (error) { disconnect(from, 'relay failed'); disconnect(to, 'relay failed') }
      })
    })
    from.once('close', () => disconnect(to, 'peer disconnected'))
    from.on('error', () => disconnect(to, 'peer error'))
  }

  function upgrade(req, socket, head) {
    const url = new URL(req.url, 'http://localhost')
    if (!url.pathname.startsWith('/acp-relay/')) return
    const role = url.pathname.slice('/acp-relay/'.length)
    const name = req.headers['x-pac-name']
    const channel = req.headers['x-pac-channel']
    const authorization = req.headers.authorization
    if (!['register', 'source', 'agent'].includes(role) || typeof name !== 'string' || !namePattern.test(name) ||
        typeof authorization !== 'string' || !authorization.startsWith('Bearer ') ||
        (role === 'agent' && (typeof channel !== 'string' || !channelPattern.test(channel)))) return reject(socket, '400 Bad Request')
    let allowed = false
    try { allowed = authorize({ role, name, token: authorization.slice(7) }) === true } catch {}
    if (!allowed) return reject(socket, '401 Unauthorized')
    if (role === 'register' && agents.has(name)) return reject(socket, '409 Conflict')
    if (role === 'source' && agents.get(name)?.readyState !== WebSocket.OPEN) return reject(socket, '503 Service Unavailable')
    if (role === 'source' && pending.size >= maxPending) return reject(socket, '503 Service Unavailable')
    if (role === 'agent' && (!pending.has(channel) || pending.get(channel).name !== name || pending.get(channel).agent)) return reject(socket, '404 Not Found')
    websocket.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => {})
      if (role === 'register') {
        agents.set(name, ws)
        activeByRegistration.set(ws, new Set())
        ws.once('close', () => {
          if (agents.get(name) === ws) agents.delete(name)
          for (const [id, entry] of pending) if (entry.name === name) { cleanupPending(id); disconnect(entry.source, 'PAC disconnected'); if (entry.agent) disconnect(entry.agent, 'PAC disconnected') }
          for (const pair of activeByRegistration.get(ws) || []) { disconnect(pair.source, 'PAC disconnected'); disconnect(pair.agent, 'PAC disconnected') }
          activeByRegistration.delete(ws)
        })
      } else if (role === 'source') {
        const id = randomUUID()
        const buffered = []
        let bufferedBytes = 0
        const buffer = (data, binary) => {
          bufferedBytes += data.length
          if (bufferedBytes > maxBufferedBytes) return disconnect(ws, 'relay buffer exceeded')
          buffered.push({ data, binary })
        }
        ws.on('message', buffer)
        const timer = setTimeout(() => {
          const entry = cleanupPending(id)
          disconnect(ws, 'PAC open timed out')
          if (entry?.agent) disconnect(entry.agent, 'PAC open timed out')
        }, openTimeoutMs)
        pending.set(id, { name, source: ws, timer, buffered, buffer, registration: agents.get(name) })
        ws.once('close', () => {
          const entry = cleanupPending(id)
          if (entry?.agent) disconnect(entry.agent, 'source disconnected')
        })
        agents.get(name).send(JSON.stringify({ type: 'open', channel: id }), (error) => {
          if (error) { cleanupPending(id); disconnect(ws, 'PAC unavailable') }
        })
      } else {
        pending.get(channel).agent = ws
        ws.once('close', () => {
          const entry = pending.get(channel)
          if (entry?.agent === ws) { cleanupPending(channel); disconnect(entry.source, 'PAC unavailable') }
        })
        ws.once('message', (data, binary) => {
          if (binary || data.toString() !== 'ready') return disconnect(ws, 'invalid readiness')
          const entry = cleanupPending(channel)
          if (!entry || entry.source.readyState !== WebSocket.OPEN) return disconnect(ws, 'source unavailable')
          const active = activeByRegistration.get(entry.registration)
          if (!active || entry.registration.readyState !== WebSocket.OPEN) { disconnect(entry.source, 'PAC disconnected'); return disconnect(ws, 'PAC disconnected') }
          const pair = { source: entry.source, agent: ws }
          active.add(pair)
          const remove = () => active.delete(pair)
          entry.source.once('close', remove)
          ws.once('close', remove)
          entry.source.off('message', entry.buffer)
          forward(ws, entry.source)
          forward(entry.source, ws)
          for (const message of entry.buffered) ws.send(message.data, { binary: message.binary })
        })
      }
    })
  }

  server.on('upgrade', upgrade)
  return {
    close() {
      server.off('upgrade', upgrade)
      for (const id of pending.keys()) cleanupPending(id)
      for (const client of websocket.clients) client.terminate()
      websocket.close()
    },
  }
}
