import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { isMap, isScalar, parseDocument } from 'yaml'

const namePattern = /^[a-z0-9][a-z0-9-]{0,63}$/

function parseSkill(text, directoryName) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!match) throw new Error('A supported skill must have simple frontmatter')
  const document = parseDocument(match[1], { uniqueKeys: true })
  if (document.errors.length || document.warnings.length || !isMap(document.contents)) throw new Error('Unsupported skill frontmatter')
  const fields = {}
  for (const pair of document.contents.items) {
    if (!isScalar(pair.key) || !isScalar(pair.value) || !['name', 'description'].includes(pair.key.value) ||
        typeof pair.value.value !== 'string' || !pair.value.value.trim() || fields[pair.key.value] !== undefined) throw new Error('Unsupported skill frontmatter')
    fields[pair.key.value] = pair.value.value
  }
  const name = fields.name || directoryName
  if (!namePattern.test(name) || typeof fields.description !== 'string' || fields.description.length > 1536) throw new Error('Invalid skill name or description')
  if (/!`|\$ARGUMENTS\[|\$\d|\$\{/.test(match[2])) throw new Error('Unsupported dynamic skill substitution')
  return { name, description: fields.description, body: match[2] }
}

export async function createSourceSkills({ root, home, maxBytes = 256 * 1024, maxSkills = 100 }) {
  if (!isAbsolute(root) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxSkills) || maxSkills < 1) throw new Error('Invalid skill configuration')
  const workspace = await realpath(root)
  const homeRoot = home ? await realpath(home) : null
  const skills = new Map()
  const seenDirectories = new Set()
  let entryCount = 0
  const roots = [
    ...[['.opencode', 'skill'], ['.opencode', 'skills'], ['.agents', 'skills'], ['.claude', 'skills']].map((parts) => ({ base: workspace, parts, global: false })),
    ...(homeRoot ? [['.config', 'opencode', 'skill'], ['.config', 'opencode', 'skills'], ['.agents', 'skills'], ['.claude', 'skills']].map((parts) => ({ base: homeRoot, parts, global: true })) : []),
  ]
  for (const { base, parts, global } of roots) {
    const skillsPath = join(base, ...parts)
    let directory
    try { directory = await realpath(skillsPath) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    const local = relative(base, directory)
    if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error('Skill directory resolves outside the workspace')
    if (seenDirectories.has(directory)) continue
    seenDirectories.add(directory)
    const entries = await readdir(directory, { withFileTypes: true })
    entryCount += entries.length
    if (entryCount > maxSkills) throw new Error('Skill directories exceed the entry limit')
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error('Symbolic links in the skill directory are unsupported')
      if (!entry.isDirectory()) continue
      const folder = join(directory, entry.name)
      const path = join(folder, 'SKILL.md')
      try { if ((await lstat(path)).isSymbolicLink()) throw new Error('Symbolic skill files are unsupported') } catch (error) { if (error.code === 'ENOENT') continue; throw error }
      const actual = await realpath(path)
      const relativePath = relative(base, actual)
      if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw new Error('Skill file resolves outside the workspace')
      const file = await open(actual, 'r')
      let text
      try {
        const bytes = Buffer.alloc(maxBytes + 1)
        let offset = 0
        while (offset < bytes.length) {
          const result = await file.read(bytes, offset, bytes.length - offset, offset)
          if (!result.bytesRead) break
          offset += result.bytesRead
        }
        if (offset > maxBytes) throw new Error('Skill exceeds the size limit')
        text = new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(0, offset))
      } finally { await file.close() }
      const skill = parseSkill(text, entry.name)
      if (skills.has(skill.name)) {
        if (global) continue
        throw new Error('Duplicate source skill name')
      }
      skills.set(skill.name, { ...skill, folder })
    }
  }
  return {
    list: [...skills.values()].map(({ name, description }) => ({ name, description })),
    rootFor(name) {
      if (typeof name !== 'string') throw new Error('Invalid skill name')
      const skill = skills.get(name.startsWith('/') ? name.slice(1) : name)
      if (!skill) throw new Error('Unknown source skill')
      return skill.folder
    },
    async invoke({ name, args = '' }) {
      if (typeof name !== 'string' || typeof args !== 'string' || args.length > 16384) throw new Error('Invalid skill invocation')
      const skill = skills.get(name.startsWith('/') ? name.slice(1) : name)
      if (!skill) throw new Error('Unknown source skill')
      let received = false
      const expanded = skill.body.replace(/(\\*)(\$ARGUMENTS)(?![A-Za-z0-9_\[])/g, (_match, slashes, token) => {
        if (slashes.length === 1) return token
        received = true
        return slashes + args
      })
      const body = received || !args ? expanded : `${expanded}\n\nARGUMENTS: ${args}`
      return { content: `Base directory for this skill: ${skill.folder}\n\n${body}` }
    },
  }
}
