import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { connectSource } from './acp-transport.mjs'
import { openPacSession } from './pac-session.mjs'
import { createSourceSkills } from './source-skills.mjs'
import { readOpenCodeInstructions } from './opencode-instructions.mjs'
import { pacModelLabel } from './pac-model-label.mjs'

export async function discoverPacsDirect({ cwd, env, timeoutMs = 18000 }) {
  if (typeof cwd !== 'string' || !cwd || !env || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Invalid PAC discovery configuration')
  const records = env.PAC_ENDPOINTS_FILE ? JSON.parse(await readFile(env.PAC_ENDPOINTS_FILE, 'utf8')) : [{
    id: env.PAC_NAME, name: env.PAC_NAME, displayName: env.PAC_DISPLAY_NAME, modelPrefix: env.PAC_MODEL_PREFIX, url: env.PAC_RELAY_URL, tokenFile: env.PAC_SOURCE_TOKEN_FILE, cwd: env.PAC_CONTROLLER_CWD,
  }]
  if (!Array.isArray(records) || !records.length) throw new Error('At least one PAC endpoint is required')
  const names = new Set(), ids = new Set(), labels = new Set()
  for (const entry of records) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || typeof entry.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(entry.name) ||
        typeof entry.url !== 'string' || typeof entry.tokenFile !== 'string' || typeof entry.cwd !== 'string' || !entry.cwd || (entry.displayName !== undefined && (typeof entry.displayName !== 'string' || !entry.displayName.trim() || entry.displayName.length > 64 || /[\x00-\x1f\x7f]/.test(entry.displayName))) || (entry.modelPrefix !== undefined && (typeof entry.modelPrefix !== 'string' || !entry.modelPrefix.trim() || entry.modelPrefix.length > 32 || /[\x00-\x1f\x7f]/.test(entry.modelPrefix))) || names.has(entry.name.toLowerCase()) || ids.has(entry.id) || labels.has((entry.displayName || entry.name).trim().toLowerCase())) throw new Error('Invalid or duplicate PAC endpoint')
    names.add(entry.name.toLowerCase()); ids.add(entry.id); labels.add((entry.displayName || entry.name).trim().toLowerCase())
  }
  const sourceHome = (process.platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME) || homedir()
  let skills, instructions
  try {
    if (env.PAC_EXPERIMENTAL_SKILLS === '1') skills = await createSourceSkills({ root: cwd, home: sourceHome, env })
    if (env.PAC_EXPERIMENTAL_INSTRUCTIONS === '1') instructions = await readOpenCodeInstructions({ root: cwd, home: sourceHome, env })
  } catch {
    return {models:[], warnings:records.map(({name}) => ({name,code:'source_setup_failed'}))}
  }
  const results = await Promise.all(records.map(async (entry) => {
    let remote, stream
    const cancellation = new AbortController()
    const timer = setTimeout(() => cancellation.abort(), timeoutMs)
    const closeStream = () => stream?.destroy()
    cancellation.signal.addEventListener('abort', closeStream, { once: true })
    try {
      const token = (await readFile(entry.tokenFile, { encoding: 'utf8', signal: cancellation.signal })).trim()
      stream = await connectSource({ ...entry, token, signal: cancellation.signal })
      if (cancellation.signal.aborted) throw new Error('PAC discovery timed out')
      remote = await openPacSession(stream, { cwd: entry.cwd, meta: { pac: { workspaceCwd: cwd, skills: skills?.list || [], instructions: instructions || [] } },
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true, subagents: {} },
        onRequest: async () => { throw new Error('Discovery cannot approve actions') }, onNotification: () => {} })
      const models = remote.models.models.filter((item) => typeof item.id === 'string' && item.id.length <= 256 && /^[A-Za-z0-9_.:@/-]+$/.test(item.id))
        .map((item) => ({ id: `PAC_${entry.name}/${item.id}`, name: pacModelLabel(entry, item) }))
      return { models }
    } catch { return { models: [], warning: { name: entry.name, code: 'unavailable' } } }
    finally { clearTimeout(timer); cancellation.signal.removeEventListener('abort', closeStream); remote?.close(); stream?.destroy() }
  }))
  return { models: results.flatMap((result) => result.models), warnings: results.flatMap((result) => result.warning ? [result.warning] : []) }
}
