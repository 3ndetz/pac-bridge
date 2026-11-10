import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { spawnContained, stopContained } from './spawn-contained.mjs'

function within(root, path) {
  const value = relative(root, path)
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value))
}

export async function createTerminalManager({ root, sessionId, authorize, maxSessions = 8, maxOutputBytes = 1024 * 1024 }) {
  if (!isAbsolute(root) || !sessionId || typeof authorize !== 'function' || !Number.isSafeInteger(maxSessions) || maxSessions < 1 ||
      !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new Error('Invalid terminal manager configuration')
  const realRoot = await realpath(root)
  const terminals = new Map()
  let starting = 0
  let closed = false
  function get(params) {
    if (params?.sessionId !== sessionId) throw new Error('Unknown terminal session')
    const terminal = terminals.get(params.terminalId)
    if (!terminal) throw new Error('Unknown terminal')
    return terminal
  }
  function kill(terminal) {
    if (terminal.status || !terminal.child.pid) return
    stopContained(terminal.child)
  }
  return {
    async create(params, { signal } = {}) {
      if (params?.sessionId !== sessionId) throw new Error('Unknown terminal session')
      if (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw new Error('Invalid terminal cancellation signal')
      if (closed) throw new Error('Terminal manager is closed')
      if (terminals.size + starting >= maxSessions) throw new Error('Terminal limit reached')
      starting++
      try {
        if (signal?.aborted) throw new Error('Terminal creation cancelled')
        if (typeof params.command !== 'string' || !params.command || !Array.isArray(params.args) || params.args.some((value) => typeof value !== 'string')) throw new Error('Invalid terminal command')
        const cwd = await realpath(params.cwd || realRoot)
        if (!within(realRoot, cwd)) throw new Error('Terminal working directory is outside the workspace')
        const overrides = {}
        for (const entry of params.env || []) {
          if (!entry || typeof entry.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name) || typeof entry.value !== 'string') throw new Error('Invalid terminal environment')
          overrides[entry.name] = entry.value
        }
        let abort
        const cancelled = signal ? new Promise((_, reject) => {
          abort = () => reject(new Error('Terminal creation cancelled'))
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        }) : new Promise(() => {})
        let authorized
        try { authorized = await Promise.race([authorize({ command: params.command, args: params.args, cwd, env: overrides }, { signal }), cancelled]) }
        finally { if (abort) signal.removeEventListener('abort', abort) }
        if (authorized !== true) throw new Error('Terminal command not authorized')
        if (signal?.aborted) throw new Error('Terminal creation cancelled')
        if (closed) throw new Error('Terminal manager is closed')
        const limit = params.outputByteLimit === undefined ? maxOutputBytes : Math.min(maxOutputBytes, params.outputByteLimit)
        if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid terminal output limit')
        const child = spawnContained(params.command, params.args, { cwd, env: { ...process.env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        const id = randomUUID()
        const terminal = { child, output: Buffer.alloc(0), truncated: false, status: null, done: null }
        function append(chunk) {
          const data = Buffer.concat([terminal.output, chunk])
          if (data.length > limit) terminal.truncated = true
          terminal.output = data.subarray(Math.max(0, data.length - limit))
        }
        child.stdout.on('data', append)
        child.stderr.on('data', append)
        terminal.done = new Promise((resolve) => {
          child.on('error', (error) => { append(Buffer.from(error.message)); terminal.status = { exitCode: 127, signal: null }; resolve(terminal.status) })
          child.on('close', (exitCode, signal) => { terminal.status ??= { exitCode, signal }; resolve(terminal.status) })
        })
        terminals.set(id, terminal)
        return { terminalId: id }
      } finally { starting-- }
    },
    output(params) {
      const terminal = get(params)
      return { output: terminal.output.toString('utf8'), truncated: terminal.truncated, ...(terminal.status ? { exitStatus: terminal.status } : {}) }
    },
    async waitForExit(params) { return await get(params).done },
    async kill(params) { const terminal = get(params); kill(terminal); await terminal.done; return {} },
    async release(params) { const terminal = get(params); kill(terminal); await terminal.done; terminals.delete(params.terminalId); return {} },
    async close() { closed = true; await Promise.all([...terminals.keys()].map((terminalId) => this.release({ sessionId, terminalId }))) },
  }
}
