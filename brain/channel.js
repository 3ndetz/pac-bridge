#!/usr/bin/env node
// A Claude Code CHANNEL: pushes a client's events into the running brain session.
//
// Claude's own background commands already announce their completion natively (verified, see
// README.md). This is for the other direction: something happens ON THE CLIENT, a game
// event, a finished build, a program asking for attention, and the brain is poked without
// polling. Any program on the client posts to the plugin's local endpoint, the plugin forwards
// it over the bridge, and this server turns it into a <channel source="pac-bridge"> event.
//
// Minimal MCP over stdio with no dependencies: the protocol here is five messages, and a
// dependency tree is not worth that. Channels are a research preview, so a custom one is
// loaded with:  claude --mcp-config <cfg> --dangerously-load-development-channels server:pac-bridge
//
// Environment: PAC_BRIDGE, PAC_BRAIN_TOKEN, PAC_CLIENT (the same three the shell uses), and
// PAC_CHANNEL_TYPES, a comma list of event type prefixes to forward (default "pac.,bridge.").

const http = require('node:http')

const BRIDGE = process.env.PAC_BRIDGE || 'http://pac-bridge:8790'
const CLIENT = process.env.PAC_CLIENT
const TOKEN = process.env.PAC_BRAIN_TOKEN
const TYPES = (process.env.PAC_CHANNEL_TYPES || 'pac.,bridge.').split(',').filter(Boolean)

const out = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
const err = (...a) => process.stderr.write('[pac-channel] ' + a.join(' ') + '\n')

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let m
    try { m = JSON.parse(line) } catch { continue }
    if (m.method === 'initialize') {
      out({ id: m.id, result: {
        protocolVersion: m.params?.protocolVersion || '2025-06-18',
        capabilities: { experimental: { 'claude/channel': {} } },
        serverInfo: { name: 'pac-bridge', version: '1' },
        instructions: `Events from the client "${CLIENT}" arrive as <channel source="pac-bridge" ...>. ` +
          'They are one-way: something happened on the machine your commands run on. Read the event ' +
          'and act on it if it concerns your task; no reply is expected.',
      } })
    } else if (m.method === 'ping') {
      out({ id: m.id, result: {} })
    } else if (m.id !== undefined && m.method) {
      // Anything else that expects an answer gets an honest "not here", never silence.
      out({ id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } })
    }
  }
})
process.stdin.on('end', () => process.exit(0))

function push(e) {
  const ev = e.event || {}
  const type = String(ev.type || '')
  if (!TYPES.some((p) => type.startsWith(p))) return
  const content = ev.text || ev.message || (type === 'bridge.client.disconnected'
    ? `the client ${e.client} disconnected: commands cannot run until it reconnects`
    : type === 'bridge.client.connected' ? `the client ${e.client} is connected` : JSON.stringify(ev))
  const meta = { client: String(e.client), type: type.replace(/[^A-Za-z0-9_]/g, '_') }
  for (const [k, v] of Object.entries(ev.meta || {})) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) meta[k] = String(v)
  out({ method: 'notifications/claude/channel', params: { content: String(content), meta } })
}

// Follow the bridge's event stream, resuming from the last seen sequence after any drop, so a
// reconnect neither loses events nor replays the ones already delivered.
let last = null
function follow() {
  const u = new URL('/events', BRIDGE)
  u.searchParams.set('client', CLIENT)
  if (last !== null) u.searchParams.set('since', String(last))
  const req = http.get(u, { headers: { authorization: `Bearer ${TOKEN}` } }, (res) => {
    if (res.statusCode !== 200) { err('bridge answered', res.statusCode); res.resume(); return retry() }
    res.setEncoding('utf8')
    let s = ''
    res.on('data', (d) => {
      s += d
      let i
      while ((i = s.indexOf('\n\n')) >= 0) {
        const block = s.slice(0, i)
        s = s.slice(i + 2)
        const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('')
        if (!data) continue
        try { const e = JSON.parse(data); last = e.seq; push(e) } catch {}
      }
    })
    res.on('end', retry)
  })
  req.on('error', (e) => { err('bridge unreachable:', e.message); retry() })
}
let waiting = false
function retry() {
  if (waiting) return
  waiting = true
  setTimeout(() => { waiting = false; follow() }, 3000)
}

if (!CLIENT || !TOKEN) err('PAC_CLIENT and PAC_BRAIN_TOKEN must be set; no events will arrive')
else follow()
