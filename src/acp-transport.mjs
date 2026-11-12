import { once } from 'node:events'
import { WebSocket, createWebSocketStream } from 'ws'
import { spawnContained, stopContained } from './spawn-contained.mjs'

function endpoint(baseUrl, role) {
  const url = new URL(baseUrl)
  if (url.username || url.password || url.search || url.hash || !['ws:', 'wss:'].includes(url.protocol)) throw new Error('Invalid relay URL')
  if (url.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Remote relay connections require TLS')
  url.pathname = `${url.pathname.replace(/\/$/, '')}/acp-relay/${role}`
  return url
}

function connect(baseUrl, role, name, token, channel) {
  if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw new Error('Invalid relay credential')
  return new WebSocket(endpoint(baseUrl, role), { handshakeTimeout: 15000, headers: {
    authorization: `Bearer ${token}`,
    'x-pac-name': name,
    ...(channel ? { 'x-pac-channel': channel } : {}),
  } })
}

export async function connectSource({ url, name, token, signal }) {
  const socket = connect(url, 'source', name, token)
  const abort = () => socket.terminate()
  if (signal?.aborted) { socket.on('error', () => {}); socket.terminate(); throw new Error('PAC connection cancelled') }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    await once(socket, 'open')
    return createWebSocketStream(socket)
  } finally { signal?.removeEventListener('abort', abort) }
}

export async function startAgent({ url, name, token, command, args = [], cwd, env, maxSessions = 8, onError = () => {}, onDisconnect = () => {} }) {
  if (typeof command !== 'string' || !command || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string') ||
      !Number.isSafeInteger(maxSessions) || maxSessions < 1 || typeof onError !== 'function' || typeof onDisconnect !== 'function') throw new Error('Invalid agent configuration')
  const active = new Set()
  let stopped = false
  const registration = connect(url, 'register', name, token)
  registration.on('error', onError)

  registration.on('message', async (data) => {
    let request
    try { request = JSON.parse(data.toString()) } catch { return }
    if (stopped || request.type !== 'open' || typeof request.channel !== 'string' || active.size >= maxSessions) return
    const session = { socket: null, child: null }
    active.add(session)
    try {
      const socket = connect(url, 'agent', name, token, request.channel)
      session.socket = socket
      socket.on('error', onError)
      await once(socket, 'open')
      if (stopped) { socket.close(); return }
      const stream = createWebSocketStream(socket)
      stream.on('error', onError)
      const child = spawnContained(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      session.child = child
      child.stderr.once('data', () => onError(new Error('Agent wrote to stderr; contents suppressed to protect session data')))
      child.stderr.resume()
      child.on('error', (error) => { onError(error); stream.destroy(error) })
      child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') onError(error) })
      stream.pipe(child.stdin)
      child.stdout.pipe(stream)
      stream.once('close', () => { try { stopContained(child) } catch (error) { onError(error) } })
      child.once('close', () => stream.end())
      socket.once('close', () => {
        active.delete(session)
        try { stopContained(child) } catch (error) { onError(error) }
      })
      socket.send('ready')
    } catch (error) {
      active.delete(session)
      session.socket?.terminate()
      onError(error)
    }
  })

  function stopSessions() {
    for (const session of active) {
      session.socket?.terminate()
      if (session.child) try { stopContained(session.child) } catch (error) { onError(error) }
    }
    active.clear()
  }
  registration.once('close', () => {
    const unexpected = !stopped
    stopped = true
    stopSessions()
    if (unexpected) onDisconnect()
  })

  // Install the open-request handler before registration becomes visible to
  // sources; the relay may send a request immediately after the handshake.
  await once(registration, 'open')

  return {
    close() {
      stopped = true
      registration.close()
      stopSessions()
    },
  }
}
