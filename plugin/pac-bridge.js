/**
 * pac-bridge.js: the client half of the brains-here, hands-there bridge, as an opencode plugin.
 *
 * It dials OUT to the complex over a WebSocket and keeps the connection, so this machine needs
 * no open port and may sit behind NAT. Over that connection a brain in the complex runs commands
 * here, exactly as if its own Bash tool were local, and this machine's opencode events go back.
 *
 * Why a plugin: opencode is already the standard body on every client, and its binary carries
 * the Bun runtime, so the hands need nothing installed beside it. The same opencode is also the
 * fallback brain (DeepSeek or any other model) when the complex's Claude is not available.
 *
 * Configuration, all three required, otherwise the plugin stays inert:
 *   PAC_BRIDGE_URL     ws://pac-bridge:8790/client
 *   PAC_CLIENT_NAME    the name this client is registered under in the complex
 *   PAC_CLIENT_TOKEN   its token
 * and one optional:
 *   PAC_EVENTS_PORT    local port for events from this machine's own programs (default 4099)
 *
 * Poking the brain from the client: any program here may
 *   curl -s -X POST 127.0.0.1:4099/event -d '{"text":"the build finished","meta":{"job":"42"}}'
 * and the brain's session receives it as a channel event. Bound to 127.0.0.1 only.
 *
 * ⛔ opencode loads plugins LAZILY, on the first request an instance serves. Measured
 * 2026-09-22 in production: a server up for four days had loaded no plugin at all. Whoever starts
 * `opencode serve` must touch it once (any GET, e.g. /config) or the bridge never connects.
 *
 * The design: README.md of pac-bridge.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { hostname, constants } from "node:os"

const URL_ = process.env.PAC_BRIDGE_URL
const NAME = process.env.PAC_CLIENT_NAME
const TOKEN = process.env.PAC_CLIENT_TOKEN
const log = (...a) => console.error("[pac-bridge]", ...a)
// Present exactly while the connection is up, so whoever needs the hands (a project's loop about
// to raise a brain) can wait for it with `test -f` instead of guessing from a log.
const MARK = "/tmp/pac-bridge.connected"

const b64 = (u8) => Buffer.from(u8).toString("base64")

// One connection per process, however many project instances load this plugin.
const S = (globalThis.__pacBridge ??= { ws: null, started: false, procs: new Map(), backoff: 1000 })

function send(msg) {
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(msg))
}

async function pump(stream, id, fd) {
  const reader = stream.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    if (value && value.length) send({ t: "out", id, fd, data: b64(value) })
  }
}

async function exec(m) {
  if (m.cwd && !existsSync(m.cwd)) {
    send({ t: "out", id: m.id, fd: 2, data: b64(Buffer.from(`pac-bridge: no such directory on ${NAME}: ${m.cwd}\n`)) })
    send({ t: "exit", id: m.id, code: 1 })
    return
  }
  let p
  try {
    // setsid: the command gets its own process group, so a kill reaches everything it started.
    p = Bun.spawn(["setsid", "-w", "bash", m.login ? "-lc" : "-c", m.command], {
      cwd: m.cwd || process.cwd(),
      env: { ...process.env, ...m.env },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    })
  } catch (e) {
    send({ t: "out", id: m.id, fd: 2, data: b64(Buffer.from(`pac-bridge: spawn failed: ${e}\n`)) })
    send({ t: "exit", id: m.id, code: 127 })
    return
  }
  S.procs.set(m.id, p)
  const pumps = Promise.all([pump(p.stdout, m.id, 1), pump(p.stderr, m.id, 2)])
  await p.exited
  // A command that leaves a daemon behind (`server &`) keeps the pipes open after it exits.
  // Waiting for EOF would hang the brain forever, so the exit is sent after at most 2 s.
  await Promise.race([pumps, new Promise((r) => setTimeout(r, 2000))])
  S.procs.delete(m.id)
  // Files the brain asked back, read AFTER the command, e.g. Claude Code's cwd-tracking file.
  const files = {}
  for (const f of m.returnFiles || []) {
    try { files[f] = readFileSync(f, "utf8"); unlinkSync(f) } catch (_) {}
  }
  const sig = p.signalCode || null
  const code = p.exitCode ?? 128 + ((sig && constants.signals[sig]) || 9)
  send({ t: "exit", id: m.id, code, signal: sig, files })
}

// The raw surface of this machine's opencode: the complex calls its HTTP API through the bridge
// exactly as if it were local. Creating sessions, prompting with any model, reading messages,
// aborting, answering permissions: all of it, and nothing narrowed into a verb of our own.
async function relay(m) {
  try {
    const r = await fetch(S.opencode + m.path, {
      method: m.method || "GET",
      headers: { "content-type": "application/json", ...(m.headers || {}) },
      body: m.body === undefined ? undefined : typeof m.body === "string" ? m.body : JSON.stringify(m.body),
    })
    send({ t: "http.res", id: m.id, status: r.status, type: r.headers.get("content-type") || "", body: await r.text() })
  } catch (e) {
    send({ t: "http.res", id: m.id, status: 502, type: "text/plain", body: `opencode at ${S.opencode} did not answer: ${e}` })
  }
}

function kill(id) {
  const p = S.procs.get(id)
  if (!p) return
  try { process.kill(-p.pid, "SIGTERM") } catch (_) { try { p.kill("SIGTERM") } catch (_) {} }
  setTimeout(() => { try { process.kill(-p.pid, "SIGKILL") } catch (_) {} }, 3000)
}

function connect() {
  const ws = new WebSocket(URL_)
  S.ws = ws
  ws.onopen = () => {
    S.backoff = 1000
    ws.send(JSON.stringify({ t: "hello", client: NAME, token: TOKEN,
      info: { host: hostname(), pid: process.pid, cwd: process.cwd(), runtime: `bun ${Bun.version}` } }))
    log("connected to", URL_, "as", NAME)
    try { writeFileSync(MARK, new Date().toISOString()) } catch (_) {}
  }
  ws.onmessage = (ev) => {
    let m
    try { m = JSON.parse(ev.data) } catch (_) { return }
    if (m.t === "exec") exec(m).catch((e) => send({ t: "exit", id: m.id, code: 255, error: String(e) }))
    else if (m.t === "kill") kill(m.id)
    else if (m.t === "http") relay(m)
  }
  ws.onclose = (ev) => {
    if (S.ws !== ws) return
    S.ws = null
    try { unlinkSync(MARK) } catch (_) {}
    // A refused token is permanent: retrying it every second would only fill the log.
    if (ev.code === 4003) return log("the complex refused this client's token; not retrying")
    log("disconnected", ev.code, "retry in", S.backoff, "ms")
    setTimeout(connect, S.backoff)
    S.backoff = Math.min(S.backoff * 2, 30000)
  }
  ws.onerror = () => {}
}

// The raw surface for this machine's programs: POST /event, and it reaches the brain.
function listen() {
  const port = Number(process.env.PAC_EVENTS_PORT || 4099)
  try {
    Bun.serve({ hostname: "127.0.0.1", port, async fetch(req) {
      if (req.method !== "POST" || new URL(req.url).pathname !== "/event") return new Response("POST /event\n", { status: 404 })
      let e
      try { e = await req.json() } catch (_) { return new Response("body must be JSON\n", { status: 400 }) }
      const type = String(e.type || "pac.event")
      send({ t: "event", event: { ...e, type: type.startsWith("pac.") ? type : `pac.${type}` } })
      return new Response(S.ws && S.ws.readyState === 1 ? "sent\n" : "not connected to the complex\n",
        { status: S.ws && S.ws.readyState === 1 ? 200 : 503 })
    } })
    log("events endpoint on 127.0.0.1:" + port)
  } catch (e) { log("events endpoint not started:", e) }
}

export const PacBridge = async (input) => {
  const { directory } = input
  // Where this opencode listens. The plugin is told by the server itself when it can be, and by
  // PAC_OPENCODE_URL otherwise, because the port is chosen by whoever ran `opencode serve`.
  S.opencode ??= String(input.serverUrl || process.env.PAC_OPENCODE_URL || "http://127.0.0.1:4096").replace(/\/$/, "")
  if (URL_ && NAME && TOKEN && !S.started) {
    log("plugin input keys:", Object.keys(input).join(","), "opencode at", S.opencode)
    S.started = true
    connect()
    listen()
  }
  return {
    // Everything opencode reports (session idle, tool calls, errors) goes to the complex, which
    // is how a brain elsewhere learns that work here finished without polling for it.
    event: async ({ event }) => send({ t: "event", event: { ...event, directory } }),
  }
}
