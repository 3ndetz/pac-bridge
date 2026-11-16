import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import { ListRootsRequestSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnContained, stopContained } from './spawn-contained.mjs'

function bounded(promise, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(reject, new Error('Source MCP operation timed out')), timeoutMs)
    const abort = () => finish(reject, new Error('Source MCP operation cancelled'))
    const finish = (fn, value) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(value) }
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error))
    if (signal?.aborted) return abort()
    signal?.addEventListener('abort', abort, { once: true })
  })
}

async function cleanup(transport) {
  try { await transport.close() } catch { throw new Error('Source MCP process cleanup could not be confirmed') }
}

export class ContainedTransport {
  constructor(config, cwd, env, timeoutMs, stop = stopContained, cleanupTimeoutMs = 5000) { this.config = config; this.cwd = cwd; this.env = env; this.timeoutMs = timeoutMs; this.stopChild = stop; this.cleanupTimeoutMs = cleanupTimeoutMs; this.buffer = new ReadBuffer({ maxBufferSize: 16 * 1024 * 1024 }) }
  async start() {
    this.child = spawnContained(this.config.command[0], this.config.command.slice(1), { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    this.child.stdout.on('data', chunk => { try { this.buffer.append(chunk); let message; while ((message = this.buffer.readMessage()) !== null) this.onmessage?.(message) } catch (error) { this.onerror?.(error); void this.close().catch(() => {}) } })
    this.child.stdin.on('error', error => this.onerror?.(error))
    this.child.stdout.on('error', error => this.onerror?.(error))
    this.child.on('error', error => this.onerror?.(error))
    this.closed = new Promise(resolve => this.child.once('close', () => { resolve(); this.onclose?.() }))
    await new Promise((resolve, reject) => { this.child.once('spawn', resolve); this.child.once('error', reject) })
  }
  async send(message) {
    const stream = this.child?.stdin
    if (!stream?.writable) throw new Error('Source MCP connection closed')
    try { await bounded(new Promise((resolve, reject) => stream.write(serializeMessage(message), error => error ? reject(error) : resolve())), this.timeoutMs) }
    catch (error) { await cleanup(this); throw error }
  }
  close() { return this.closing ??= this.stop() }
  async stop() {
    if (!this.child) return
    const child = this.child; this.child = null
    const exited = this.closed || new Promise(resolve => child.once('close', resolve))
    if (child.exitCode !== null || child.signalCode !== null) {
      await bounded(exited, this.cleanupTimeoutMs)
      return
    }
    let stopError
    try { this.stopChild(child) } catch (error) { stopError = error }
    try { await bounded(exited, this.cleanupTimeoutMs) } catch { throw stopError || new Error('Source MCP process cleanup timed out') }
  }
}

export async function openLocalSourceMcp({ config, cwd, verifyProvenance, approveStart, authorize, onChanged = () => {}, env = process.env, timeoutMs = 30000, startupTimeoutMs = 30000, signal }) {
  try { config = structuredClone(config) } catch { throw new Error('Unsupported source MCP configuration') }
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      Object.keys(config).some(key => !['type', 'command', 'enabled', 'environment'].includes(key)) ||
      config.type !== 'local' || config.enabled !== true || !Array.isArray(config.command) || !config.command.length ||
      config.command.some(value => typeof value !== 'string' || !value || /\{(?:env|file):/.test(value)) ||
      !isAbsolute(cwd) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000 || !Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 1 || startupTimeoutMs > 300000 || typeof verifyProvenance !== 'function' || typeof approveStart !== 'function' || typeof authorize !== 'function' || typeof onChanged !== 'function') throw new Error('Unsupported source MCP configuration')
  const vars = config.environment ?? {}
  if (!vars || typeof vars !== 'object' || Array.isArray(vars) || Object.entries(vars).some(([key, value]) => !key || key.includes('=') || typeof value !== 'string' || /\{(?:env|file):/.test(value))) throw new Error('Unsupported source MCP configuration')
  if (await bounded(verifyProvenance({ config: structuredClone(config), cwd }), timeoutMs, signal) !== true || await bounded(approveStart({ config: structuredClone(config), cwd }), timeoutMs, signal) !== true) throw new Error('Source MCP startup not authorized')
  if (signal?.aborted) throw new Error('Source MCP operation cancelled')
  let closed = false, generation = 0, catalog = new Set()
  const pending = new Set()
  const client = new Client({ name: 'pac-source-mcp', version: '1.0.0' }, { capabilities: { roots: {} } })
  const transport = new ContainedTransport(config, cwd, { ...env, ...vars }, timeoutMs)
  client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(cwd).href }] }))
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    generation++; catalog.clear()
    if (!closed) onChanged()
  })
  const previousClose = client.onclose
  client.onclose = () => { const unexpected = !closed; closed = true; generation++; catalog.clear(); for (const c of pending) c.abort(); previousClose?.(); if (unexpected) onChanged() }
  try { await bounded(client.connect(transport), startupTimeoutMs, signal) } catch { await cleanup(transport); throw new Error('Source MCP connection failed') }
  return {
    async list() {
      if (closed) throw new Error('Source MCP connection closed')
      const version = generation, tools = [], names = new Set(), cursors = new Set()
      let cursor, pages = 0
      try {
        do {
          if (++pages > 256) throw new Error('Too many pages')
          const page = await client.listTools(cursor ? { cursor } : {}, { timeout: timeoutMs })
          for (const tool of page.tools) {
            if (names.has(tool.name) || tools.length >= 4096) throw new Error('Invalid catalog')
            names.add(tool.name); tools.push(tool)
          }
          cursor = page.nextCursor
          if (cursor && cursors.has(cursor)) throw new Error('Invalid cursor')
          if (cursor) cursors.add(cursor)
        } while (cursor)
      } catch { await cleanup(transport); throw new Error('Source MCP discovery failed') }
      if (closed || version !== generation) throw new Error('Source MCP catalog changed during discovery')
      catalog = names
      return { tools }
    },
    async call(name, args, context, { signal } = {}) {
      if (closed || typeof name !== 'string' || !catalog.has(name) || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Source MCP tool unavailable')
      const approvedArgs = structuredClone(args)
      const version = generation, cancellation = new AbortController()
      const abort = () => cancellation.abort()
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
      pending.add(cancellation)
      try {
        let approved
        try { approved = await bounded(authorize({ name, arguments: structuredClone(approvedArgs), context, signal: cancellation.signal }), timeoutMs, cancellation.signal) }
        catch (error) { await cleanup(transport); throw error }
        if (closed || cancellation.signal.aborted || generation !== version || !catalog.has(name)) throw new Error('Source MCP call cancelled or catalog changed')
        if (approved !== true) throw new Error('Source MCP permission denied')
        try { return await client.callTool({ name, arguments: approvedArgs }, undefined, { signal: cancellation.signal, timeout: timeoutMs }) }
        catch { await cleanup(transport); throw new Error('Source MCP call failed; outcome may be unknown') }
      } finally { signal?.removeEventListener('abort', abort); pending.delete(cancellation) }
    },
    async close() { if (!closed) { closed = true; generation++; catalog.clear(); for (const c of pending) c.abort() }; await transport.close() }
  }
}
