import { readFile, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse } from 'node:path'

// JSONC comments and trailing commas are removed only outside strings.
function parseJsonc(text) {
  let output = '', quote = false, escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1]
    if (quote) {
      output += c
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') quote = false
      continue
    }
    if (c === '"') { quote = true; output += c; continue }
    if (c === '/' && next === '/') { while (i < text.length && !'\r\n'.includes(text[i])) i++; output += '\n'; continue }
    if (c === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      if (i >= text.length) throw new Error('Invalid OpenCode JSONC configuration')
      i++; output += ' '; continue
    }
    output += c
  }
  let clean = ''
  quote = false; escaped = false
  for (let i = 0; i < output.length; i++) {
    const c = output[i]
    if (quote) {
      clean += c
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') quote = false
    } else if (c === '"') { quote = true; clean += c }
    else if (c === ',') {
      let j = i + 1
      while (j < output.length && /\s/.test(output[j])) j++
      if (output[j] !== ']' && output[j] !== '}') clean += c
    } else clean += c
  }
  try { return JSON.parse(clean.replace(/^\uFEFF/, '')) } catch { throw new Error('Invalid OpenCode JSONC configuration') }
}

export async function assertNoUnsupportedOpenCodePlugins({ root, home, env = process.env }) {
  if (!isAbsolute(root) || !isAbsolute(home)) throw new Error('Invalid OpenCode plugin guard configuration')
  const workspace = await realpath(root), userHome = await realpath(home)
  const configs = new Set(), pluginDirs = new Set()
  const addConfigDirectory = (dir) => {
    for (const name of ['opencode.json', 'opencode.jsonc']) configs.add(join(dir, name))
  }
  const addPluginDirectory = (dir) => { for (const name of ['plugin', 'plugins']) pluginDirs.add(join(dir, name)) }
  const global = join(userHome, '.config', 'opencode')
  addConfigDirectory(global); addPluginDirectory(global)
  let current = workspace
  while (true) {
    addConfigDirectory(current)
    const projectConfig = join(current, '.opencode')
    addConfigDirectory(projectConfig); addPluginDirectory(projectConfig)
    if (current === parse(current).root) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  if (env.OPENCODE_CONFIG) {
    if (!isAbsolute(env.OPENCODE_CONFIG)) throw new Error('Relative OpenCode configuration is unsupported')
    configs.add(env.OPENCODE_CONFIG)
  }
  if (env.OPENCODE_CONFIG_DIR) {
    if (!isAbsolute(env.OPENCODE_CONFIG_DIR)) throw new Error('Relative OpenCode configuration directory is unsupported')
    addConfigDirectory(env.OPENCODE_CONFIG_DIR); addPluginDirectory(env.OPENCODE_CONFIG_DIR)
  }
  const checkConfig = (text) => {
    if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new Error('OpenCode configuration exceeds the size limit')
    const config = parseJsonc(text)
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid OpenCode configuration')
    for (const key of ['plugin', 'plugins']) {
      if (config[key] !== undefined && (!Array.isArray(config[key]) || config[key].length)) throw new Error('Configured OpenCode plugins and hooks are not yet supported by PAC Bridge')
    }
    const nonempty = (value) => value !== undefined && value !== null && (typeof value !== 'object' || Object.keys(value).length > 0)
    for (const key of ['permission', 'instructions', 'mcp', 'skills']) {
      if (nonempty(config[key])) throw new Error(`OpenCode ${key} configuration is not yet supported by PAC Bridge`)
    }
    if (config.agent && typeof config.agent === 'object' && Object.values(config.agent).some((agent) => agent && typeof agent === 'object' && nonempty(agent.permission))) {
      throw new Error('OpenCode agent permission configuration is not yet supported by PAC Bridge')
    }
  }
  if (env.OPENCODE_CONFIG_CONTENT) checkConfig(env.OPENCODE_CONFIG_CONTENT)
  for (const path of configs) {
    try { checkConfig(await readFile(path, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  for (const path of pluginDirs) {
    let entries
    try { entries = await readdir(path, { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    if (entries.some((entry) => entry.isDirectory() || entry.isSymbolicLink() || /\.(?:[cm]?[jt]s)$/.test(entry.name))) {
      throw new Error('Configured OpenCode plugins and hooks are not yet supported by PAC Bridge')
    }
  }
}
