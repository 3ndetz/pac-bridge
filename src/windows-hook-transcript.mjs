import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, relative, sep } from 'node:path'
import { spawnContained, stopContained, confirmContainedExit } from './spawn-contained.mjs'
const limit = 1024 * 1024
function failure(code, message) { return Object.assign(new Error(message), { code: 'PAC_PRIVATE_TRANSCRIPT_' + code }) }
function decode(value) {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(limit / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Invalid source hook transcript')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length > limit || bytes.toString('base64') !== value) throw new Error('Invalid source hook transcript')
}
function inside(root, path) {
  const local = relative(root, path)
  return local && local !== '..' && !local.startsWith('..' + sep) && !isAbsolute(local)
}
function host(request, holding) {
  const child = spawnContained('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./windows-hook-transcript.ps1', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  child.stderr.resume(); child.stdin.on('error', () => {})
  const decoder = new StringDecoder('utf8')
  let resolveReady, rejectReady, input = '', received = false
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject }); ready.catch(() => {})
  const startup = setTimeout(() => rejectReady(failure('STARTUP', 'Private Windows transcript startup timed out')), 15000)
  child.stdout.on('data', bytes => {
    input += decoder.write(bytes)
    if (input.length > 1500000) { rejectReady(new Error('Private Windows transcript response exceeds the limit')); return }
    const end = input.indexOf('\n')
    if (end < 0) return
    if (received || input.slice(end + 1).trim()) { rejectReady(new Error('Invalid private Windows transcript response')); return }
    received = true; clearTimeout(startup)
    try {
      const value = JSON.parse(input.slice(0, end))
      if (Number.isInteger(value.error) && value.error >= -1 && value.error <= 100000) {
        const error = new Error('Private Windows transcript unavailable')
        error.code = 'PAC_PRIVATE_TRANSCRIPT_' + (['owner','acl','path','policy'].includes(value.stage) ? value.stage.toUpperCase() : value.error)
        rejectReady(error)
      } else resolveReady(value)
    } catch { rejectReady(new Error('Invalid private Windows transcript response')) }
    input = ''
  })
  child.on('error', () => { clearTimeout(startup); rejectReady(failure('HOST', 'Private Windows transcript host unavailable')) })
  const closed = new Promise(resolve => child.once('close', (code) => { clearTimeout(startup); rejectReady(failure('HOST_EXIT', 'Private Windows transcript unavailable')); resolve(code) }))
  child.stdin.write(JSON.stringify(request) + '\n')
  if (!holding) child.stdin.end()
  let closing
  return { ready, close() { return closing ??= (async () => {
    if (child.stdin.writable) child.stdin.end('CLOSE\n')
    let cleanupTimer, stopError
    const stopTimer = setTimeout(() => { try { stopContained(child) } catch (error) { stopError = error } }, 1000)
    try {
      const code = await Promise.race([closed, new Promise((resolve, reject) => { cleanupTimer = setTimeout(() => reject(new Error('Private Windows transcript cleanup is unconfirmed')), 20000) })])
      await confirmContainedExit(child)
      if (stopError) throw new Error('Private Windows transcript cleanup is unconfirmed')
      return code
    } finally { clearTimeout(startup); clearTimeout(stopTimer); clearTimeout(cleanupTimer) }
  })() } }
}
export async function snapshotWindowsHookTranscript(path, { root, sessionId } = {}) {
  if (process.platform !== 'win32') throw new Error('Windows private transcript host unavailable')
  if (typeof path !== 'string' || !isAbsolute(path) || typeof root !== 'string' || !isAbsolute(root) || typeof sessionId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(sessionId) || basename(path) !== sessionId + '.jsonl' || !inside(root, path)) throw new Error('Source hook transcript is unavailable')
  const worker = host({ operation: 'snapshot', root, path }, false)
  let failed = false
  try { const result = await worker.ready; decode(result.snapshot); return result.snapshot }
  catch (error) { failed = true; throw error }
  finally { const code = await worker.close(); if (!failed && code !== 0) throw new Error('Private Windows transcript unavailable') }
}
export async function withWindowsHookTranscript(encoded, run) {
  if (process.platform !== 'win32') throw new Error('Windows private transcript host unavailable')
  decode(encoded)
  if (typeof run !== 'function') throw new Error('Invalid transcript callback')
  const root = await realpath(tmpdir()), worker = host({ operation: 'hold', root, transcript: encoded }, true)
  let failed = false
  try {
    const result = await worker.ready
    if (typeof result.path !== 'string' || !isAbsolute(result.path) || basename(result.path) !== 'transcript.jsonl' || !inside(root, result.path)) throw new Error('Private Windows transcript unavailable')
    return await run(result.path)
  } catch (error) { failed = true; throw error }
  finally { const code = await worker.close(); if (!failed && code !== 0) throw failure('CLEANUP', 'Private Windows transcript cleanup failed') }
}
