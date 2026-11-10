import { isAbsolute, relative, sep } from 'node:path'
import { minimatch } from 'minimatch'
import { parseDocument } from 'yaml'

// A comma inside a brace group belongs to the glob, not the YAML string's
// list of patterns. Nested groups are kept intact for minimatch.
function splitPatterns(value) {
  let depth = 0, current = '', result = []
  for (const character of value) {
    if (character === '{') depth++
    else if (character === '}') depth = Math.max(0, depth - 1)
    if (character === ',' && depth === 0) { result.push(current.trim()); current = '' }
    else current += character
  }
  result.push(current.trim())
  return result.filter(Boolean)
}

function safePattern(pattern) {
  let braces = 0, commas = 0, depth = 0, escaped = false, bracket = false, bracketHasContent = false
  for (const character of pattern) {
    if (escaped) { escaped = false; if (bracket) bracketHasContent = true; continue }
    if (character === '\\') { escaped = true; continue }
    if (character === '[' && !bracket) { bracket = true; bracketHasContent = false; continue }
    if (character === ']' && bracket && bracketHasContent) { bracket = false; continue }
    if (bracket) { bracketHasContent = true; continue }
    if (character === '{') { depth++; braces++ }
    else if (character === '}') depth = Math.max(0, depth - 1)
    else if (character === ',' && depth) commas++
  }
  if (braces > 128 || commas > 9) throw new Error('Rule glob expansion exceeds the supported limit')
  return !bracket
}

export function parseProjectRule(text) {
  if (typeof text !== 'string') throw new Error('Invalid project rule')
  const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text)
  if (!frontmatter) return { content: text, paths: [] }
  const content = text.slice(frontmatter[0].length)
  const document = parseDocument(frontmatter[1], { uniqueKeys: true })
  if (document.errors.length) return { content, paths: [] }
  let fields
  try { fields = document.toJS({ maxAliasCount: 0 }) } catch { throw new Error('Rule aliases are not supported') }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return { content, paths: [] }
  const raw = fields.paths
  if (raw === undefined) return { content, paths: [] }
  const values = typeof raw === 'string' ? splitPatterns(raw) : raw
  if (!Array.isArray(values) || values.length > 128 || values.some((item) => typeof item !== 'string' || !item || item.length > 2048 || item.includes('\0'))) throw new Error('Unsupported project rule paths')
  for (const value of values) safePattern(value)
  return { content, paths: values }
}

export function matchesProjectRule(root, path, patterns) {
  if (!isAbsolute(root) || !isAbsolute(path) || !Array.isArray(patterns)) throw new Error('Invalid project rule match')
  const local = relative(root, path)
  if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) return false
  const target = local.split(sep).join('/')
  return patterns.some((value) => {
    const anchored = value.startsWith('/')
    const pattern = anchored ? value.slice(1) : value
    if (!safePattern(pattern)) return false
    return minimatch(target, pattern, { dot: true, matchBase: !anchored && !pattern.includes('/'), nonegate: true, nocomment: true,
      nocase: process.platform === 'win32' })
  })
}
