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

export async function startAgent({ url, name, token, command, args = [], cwd, env, maxSessions = 8, onError = () => {}, onDisconnect = () => {}, spawnChild = spawnContained, stopChild = stopContained }) {
  if (typeof command !== 'string' || !command || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string') ||
      !Number.isSafeInteger(maxSessions) || maxSessions < 1 || typeof onError !== 'function' || typeof onDisconnect !== 'function' || typeof spawnChild !== 'function' || typeof stopChild !== 'function') throw new Error('Invalid agent configuration')
  // Diagnostics must not interrupt ownership cleanup of the other children.
  const report = (error) => { try { onError(error) } catch {} }
  const active = new Set()
  let stopped = false, registrationClosed = false
  let resolveClosed
  const closed = new Promise(resolve => { resolveClosed = resolve })
  function checkClosed() { if (stopped && registrationClosed && active.size === 0) resolveClosed() }
  function release(session) { active.delete(session); checkClosed() }
  const registration = connect(url, 'register', name, token)
  registration.on('error', report)

  registration.on('message', async (data) => {
    let request
    try { request = JSON.parse(data.toString()) } catch { return }
    if (stopped || request.type !== 'open' || typeof request.channel !== 'string' || active.size >= maxSessions) return
    const session = { socket: null, child: null }
    active.add(session)
    try {
      const socket = connect(url, 'agent', name, token, request.channel)
      session.socket = socket
      socket.on('error', report)
      await once(socket, 'open')
      if (stopped) { release(session); socket.close(); return }
      const stream = createWebSocketStream(socket)
      stream.on('error', report)
      const child = spawnChild(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      session.child = child
      child.stderr.once('data', () => report(new Error('Agent wrote to stderr; contents suppressed to protect session data')))
      child.stderr.resume()
      child.on('error', (error) => { report(error); stream.destroy(error) })
      child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') report(error) })
      stream.pipe(child.stdin)
      child.stdout.pipe(stream)
      stream.once('close', () => { try { stopChild(child) } catch (error) { report(error) } })
      child.once('close', () => {
        if (child.pacOwnedExitConfirmed === false) {
          report(new Error('Agent process-tree exit is unconfirmed; ownership retained'))
          stream.destroy()
        } else { release(session); stream.end() }
      })
      socket.once('close', () => {
        // A closed transport does not confirm the owned child's exit. Keep its
        // capacity and stop ownership until the child's own close event.
        try { stopChild(child) } catch (error) { report(error) }
      })
      socket.send('ready')
    } catch (error) {
      if (!session.child) release(session)
      else try { stopChild(session.child) } catch (stopError) { report(stopError) }
      session.socket?.terminate()
      report(error)
    }
  })

  function stopSessions() {
    for (const session of active) {
      session.socket?.terminate()
      if (session.child) try { stopChild(session.child) } catch (error) { report(error) }
      else release(session)
    }
  }
  registration.once('close', () => {
    const unexpected = !stopped
    stopped = true
    registrationClosed = true
    stopSessions()
    checkClosed()
    if (unexpected) onDisconnect({ closed })
  })

  // Install the open-request handler before registration becomes visible to
  // sources; the relay may send a request immediately after the handshake.
  await once(registration, 'open')

  return {
    closed,
    close() {
      stopped = true
      registration.close()
      stopSessions()
      checkClosed()
      return closed
    },
  }
}
