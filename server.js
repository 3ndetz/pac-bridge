// pac-bridge: brains here, hands there.
//
// Clients (a project container running opencode with plugin/pac-bridge.js) dial IN over a
// WebSocket and stay connected, so a client behind NAT needs no open port. Brains in the
// controller reach a client through plain HTTP on this server: `brain/bash` runs every
// Bash command of a Claude Code session here, and the answer streams back as NDJSON.
//
// The design, the prior art it copies and what it deliberately does not do: README.md.

import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { WebSocketServer } from 'ws'

const PORT = Number(process.env.PORT || 8790)
// {
//   "clients": { "<client name>": "<sha256 of its token>" },
//   "brains":  { "<sha256 of a brain token>": ["<client it may use>", ...] or "*" }
// }
// ⛔ A BRAIN TOKEN IS SCOPED TO ITS CLIENTS. The first version had one brain token for every
// client, so a brain working for one agent held everything it needed to run commands in another
// agent's container. A brain reaches only the clients its token lists; "*" is for the operator.
// The old list form, "brains": ["<sha256>", ...], still reads, as "*" for each.
const TOKENS = process.env.TOKENS || '/secrets/tokens.json'
const EVENTS_KEPT = 500

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')
function tokens() {
  // Re-read on every check, so a new client is added by editing the file, never by a restart.
  try { return JSON.parse(fs.readFileSync(TOKENS, 'utf8')) } catch { return { clients: {}, brains: [] } }
}
const log = (...a) => console.log(new Date().toISOString(), ...a)

const clients = new Map()      // name -> { ws, info, since, pending: Map(id -> res) }
const events = []              // ring of { seq, at, client, event }
let seq = 0
const listeners = new Set()    // SSE responses waiting for events

// The clients this request's brain token may use: '*', a Set of names, or null when unknown.
function brainScope(req) {
  const h = req.headers.authorization || ''
  const t = h.startsWith('Bearer ') ? h.slice(7) : ''
  if (!t) return null
  const b = tokens().brains || []
  if (Array.isArray(b)) return b.includes(sha(t)) ? '*' : null
  const s = b[sha(t)]
  if (s === undefined) return null
  return s === '*' ? '*' : new Set(s)
}
const may = (scope, client) => scope === '*' || (scope instanceof Set && scope.has(client))

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg))
}

function pushEvent(client, event) {
  const e = { seq: ++seq, at: Date.now(), client, event }
  events.push(e)
  if (events.length > EVENTS_KEPT) events.shift()
  for (const l of listeners) if (l.wants(e)) l.res.write(`data: ${JSON.stringify(e)}\n\n`)
}

// ---- clients ------------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 })

wss.on('connection', (ws, req) => {
  let name = null
  const hello = setTimeout(() => ws.close(4001, 'no hello'), 10000)
  ws.isAlive = true
  ws.on('pong', () => { ws.isAlive = true })

  ws.on('message', (raw) => {
    let m
    try { m = JSON.parse(raw) } catch { return }
    if (!name) {
      if (m.t !== 'hello') return ws.close(4001, 'hello first')
      const want = (tokens().clients || {})[m.client]
      if (!want || want !== sha(m.token)) {
        log('refused client', m.client, 'from', req.socket.remoteAddress)
        return ws.close(4003, 'bad token')
      }
      clearTimeout(hello)
      name = m.client
      const old = clients.get(name)
      if (old) {
        // A reconnect replaces the old socket. Anything still running there is reported dead
        // rather than left hanging: a brain waiting forever is worse than one told the truth.
        failPending(old, 'the client reconnected and this command was lost with the old socket')
        old.ws.terminate()
      }
      clients.set(name, { ws, info: m.info || {}, since: Date.now(), pending: new Map() })
      log('client up', name, JSON.stringify(m.info || {}))
      pushEvent(name, { type: 'bridge.client.connected' })
      return
    }
    const c = clients.get(name)
    if (!c || c.ws !== ws) return
    if (m.t === 'http.res') {
      const res = c.pending.get(m.id)
      if (!res) return
      c.pending.delete(m.id)
      res.writeHead(m.status || 502, { 'content-type': m.type || 'application/octet-stream' })
      res.end(m.body ?? '')
      return
    }
    if (m.t === 'out' || m.t === 'exit') {
      const res = c.pending.get(m.id)
      if (!res) return
      res.write(JSON.stringify(m) + '\n')
      if (m.t === 'exit') { c.pending.delete(m.id); res.end() }
    } else if (m.t === 'event') {
      pushEvent(name, m.event)
    }
  })

  ws.on('close', () => {
    clearTimeout(hello)
    const c = name && clients.get(name)
    if (c && c.ws === ws) {
      failPending(c, 'the client disconnected while the command was running')
      clients.delete(name)
      log('client down', name)
      pushEvent(name, { type: 'bridge.client.disconnected' })
    }
  })
})

function failPending(c, why) {
  for (const [id, res] of c.pending) {
    // A relayed HTTP call has not sent its headers yet; a command stream has.
    if (!res.headersSent) { json(res, 502, { error: why }); continue }
    res.write(JSON.stringify({ t: 'exit', id, code: 255, error: why }) + '\n')
    res.end()
  }
  c.pending.clear()
}

// Dead sockets are found by ping, not by waiting for TCP to notice, which can take minutes.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue }
    ws.isAlive = false
    ws.ping()
  }
}, 20000)

// ---- brains -------------------------------------------------------------------------------

function body(req) {
  return new Promise((ok, bad) => {
    let s = ''
    req.on('data', (d) => { s += d; if (s.length > 8e6) bad(new Error('body too large')) })
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}) } catch (e) { bad(e) } })
  })
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/healthz') return json(res, 200, { ok: true, clients: clients.size })
  const scope = brainScope(req)
  if (!scope) return json(res, 401, { error: 'brain token required' })
  // A client outside the token's scope answers exactly like one that is not connected, so a
  // brain cannot even learn which other clients exist.
  const visible = () => [...clients.keys()].filter((n) => may(scope, n))

  if (req.method === 'GET' && url.pathname === '/clients') {
    return json(res, 200, [...clients].filter(([n]) => may(scope, n))
      .map(([n, c]) => ({ client: n, since: c.since, running: c.pending.size, info: c.info })))
  }

  // Run one command on a client. The response is NDJSON: {t:"out",fd,data(base64)}... then
  // {t:"exit",code,signal,files}. Closing the request kills the command on the client, which
  // is how a brain that is itself killed (SIGKILL included) still stops what it started.
  if (req.method === 'POST' && url.pathname === '/exec') {
    let b
    try { b = await body(req) } catch (e) { return json(res, 400, { error: String(e) }) }
    const c = may(scope, b.client) && clients.get(b.client)
    if (!c) return json(res, 503, { error: `client ${b.client} is not connected`, connected: visible() })
    const id = crypto.randomUUID()
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    c.pending.set(id, res)
    res.on('close', () => {
      if (c.pending.has(id)) {
        c.pending.delete(id)
        send(c.ws, { t: 'kill', id })
      }
    })
    send(c.ws, { t: 'exec', id, command: b.command, cwd: b.cwd, login: !!b.login, env: b.env || {}, returnFiles: b.returnFiles || [] })
    return
  }

  // The client's own opencode HTTP API, relayed as it is: /opencode/<client>/<any opencode path>.
  // This is how the fallback brain is driven (POST .../session, then .../session/<id>/message
  // with a model), and anything else its API offers, without a verb of ours in between.
  const oc = /^\/opencode\/([^/]+)(\/.*)$/.exec(url.pathname)
  if (oc) {
    const name = decodeURIComponent(oc[1])
    const c = may(scope, name) && clients.get(name)
    if (!c) return json(res, 503, { error: `client ${name} is not connected`, connected: visible() })
    let raw = ''
    req.on('data', (d) => { raw += d })
    await new Promise((ok) => req.on('end', ok))
    const id = crypto.randomUUID()
    c.pending.set(id, res)
    res.on('close', () => c.pending.delete(id))
    send(c.ws, { t: 'http', id, method: req.method, path: oc[2] + url.search, body: raw || undefined })
    return
  }

  // Events from clients, as Server-Sent Events. `?since=<seq>` replays what was missed.
  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const since = Number(url.searchParams.get('since') || seq)
    const client = url.searchParams.get('client')
    const wants = (e) => may(scope, e.client) && (!client || e.client === client)
    for (const e of events) if (e.seq > since && wants(e)) res.write(`data: ${JSON.stringify(e)}\n\n`)
    const l = { res, wants }
    listeners.add(l)
    const keep = setInterval(() => res.write(': keepalive\n\n'), 15000)
    req.on('close', () => { listeners.delete(l); clearInterval(keep) })
    return
  }

  json(res, 404, { error: 'no such endpoint' })
})

server.on('upgrade', (req, sock, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/client') return sock.destroy()
  wss.handleUpgrade(req, sock, head, (ws) => wss.emit('connection', ws, req))
})

server.listen(PORT, () => log('pac-bridge listening on', PORT))
