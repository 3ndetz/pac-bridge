import { open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

// Imports are not implemented yet. Reject them instead of silently omitting
// instructions, but do not mistake Markdown code examples for imports.
function hasUnsupportedImport(text) {
  let fence = null
  let outside = ''
  for (const line of text.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length &&
          new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(line)) fence = null
      outside += '\n'
      continue
    }
    if (marker) { fence = marker[1]; outside += '\n'; continue }
    outside += `${line}\n`
  }
  // CommonMark code spans close only on a backtick run of the same length.
  let prose = ''
  for (let i = 0; i < outside.length;) {
    if (outside[i] !== '`') { prose += outside[i++]; continue }
    let end = i
    while (outside[end] === '`') end++
    const delimiter = outside.slice(i, end)
    let close = end
    let found = false
    while ((close = outside.indexOf(delimiter, close)) !== -1) {
      if (outside[close - 1] !== '`' && outside[close + delimiter.length] !== '`') { found = true; break }
      close += delimiter.length
    }
    if (!found) { prose += delimiter; i = end; continue }
    prose += ' '
    i = close + delimiter.length
  }
  return /(^|[\s([{])@(?:[.~\/\\]|[\w-])[^\s`"']*/m.test(prose)
}

export async function readSourceInstructions({ root, stopAt, maxFileBytes = 256 * 1024, maxTotalBytes = 1024 * 1024 }) {
  if (!isAbsolute(root) || (stopAt !== undefined && !isAbsolute(stopAt)) || !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 ||
      !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1) throw new Error('Invalid source instruction configuration')
  const workspace = await realpath(root)
  const boundary = stopAt ? await realpath(stopAt) : null
  const ancestors = []
  let current = workspace
  while (true) {
    ancestors.push(current)
    if (current === boundary) break
    const parent = dirname(current)
    if (parent === current) {
      if (boundary) throw new Error('Instruction boundary is not an ancestor of the workspace')
      break
    }
    current = parent
  }
  const entries = []
  let total = 0
  for (const directory of ancestors.reverse()) {
    for (const name of ['AGENTS.md', 'CLAUDE.md', join('.claude', 'CLAUDE.md')]) {
      const path = join(directory, name)
      let actual
      try { actual = await realpath(path) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
      const local = relative(directory, actual)
      if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error('Instruction file resolves outside its scope')
      const file = await open(actual, 'r')
      let text
      try {
        const buffer = Buffer.alloc(maxFileBytes + 1)
        let offset = 0
        while (offset < buffer.length) {
          const result = await file.read(buffer, offset, buffer.length - offset, offset)
          if (!result.bytesRead) break
          offset += result.bytesRead
        }
        if (offset > maxFileBytes || total + offset > maxTotalBytes) throw new Error('Source instructions exceed the size limit')
        total += offset
        text = new TextDecoder('utf8', { fatal: true }).decode(buffer.subarray(0, offset))
      } finally { await file.close() }
      if (name.endsWith('CLAUDE.md') && hasUnsupportedImport(text)) {
        throw new Error('Imported CLAUDE.md instructions are not yet supported')
      }
      entries.push({ path, content: text })
    }
  }
  return entries
}
