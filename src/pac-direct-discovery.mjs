import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { connectSource } from './acp-transport.mjs'
import { openPacSession } from './pac-session.mjs'
import { createProjectHooks } from './project-hooks.mjs'
import { createSourceSkills } from './source-skills.mjs'
import { readSourceInstructions } from './source-instructions.mjs'

export async function discoverPacsDirect({ cwd, env }) {
  if (typeof cwd !== 'string' || !cwd || !env) throw new Error('Invalid PAC discovery configuration')
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
  let skills, instructions
  try {
    if (env.PAC_EXPERIMENTAL_HOOKS === '1') {
      if (!env.PAC_SOURCE_BASH) throw new Error('A source shell is required for project hooks')
      await createProjectHooks({ root: cwd, shell: env.PAC_SOURCE_BASH })
    }
    if (env.PAC_EXPERIMENTAL_SKILLS === '1') skills = await createSourceSkills({ root: cwd, home: homedir() })
    if (env.PAC_EXPERIMENTAL_INSTRUCTIONS === '1') instructions = await readSourceInstructions({ root: cwd })
  } catch (error) {
    const code = ['Unsupported project rule paths', 'Rule aliases are not supported', 'Rule glob expansion exceeds the supported limit'].includes(error.message) ? 'rule_frontmatter_unsupported'
      : error.message === 'External instruction imports require approval and are not supported' ? 'external_import_unsupported' : 'source_setup_failed'
    return { models: [], warnings: records.map(({ name }) => ({ name, code })) }
  }
  const results = await Promise.all(records.map(async (entry) => {
    let remote
    try {
      const token = (await readFile(entry.tokenFile, 'utf8')).trim()
      const stream = await connectSource({ ...entry, token })
      remote = await openPacSession(stream, { cwd: entry.cwd, meta: { pac: { workspaceCwd: cwd, skills: skills?.list || [], instructions: (instructions || []).filter((entry) => !entry.paths) } },
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true, subagents: {} },
        onRequest: async () => { throw new Error('Discovery cannot approve actions') }, onNotification: () => {} })
      const models = remote.models.models.filter((item) => typeof item.id === 'string' && item.id.length <= 256 && /^[A-Za-z0-9_.:@/-]+$/.test(item.id))
        .map((item) => ({ id: `PAC_${entry.name}/${item.id}`, name: `PAC ${entry.displayName || entry.name} / ${entry.modelPrefix ? entry.modelPrefix + ' ' : ''}${typeof item.name === 'string' ? item.name.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200) : item.id}` }))
      return { models }
    } catch { return { models: [], warning: { name: entry.name, code: 'unavailable' } } }
    finally { remote?.close() }
  }))
  return { models: results.flatMap((result) => result.models), warnings: results.flatMap((result) => result.warning ? [result.warning] : []) }
}
