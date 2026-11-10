import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import test from 'node:test'
import { readSourceInstructions } from '../src/source-instructions.mjs'

test('reads ancestor and workspace instructions in order and rejects unsupported imports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-instructions-'))
  try {
    const workspace = join(root, 'nested')
    await mkdir(workspace)
    await writeFile(join(root, 'AGENTS.md'), 'Parent instruction')
    await writeFile(join(workspace, 'CLAUDE.md'), 'Project instruction')
    const entries = await readSourceInstructions({ root: workspace, stopAt: root })
    assert.deepEqual(entries.map((entry) => entry.content), ['Parent instruction', 'Project instruction'])
    await writeFile(join(workspace, 'CLAUDE.md'), 'See @docs/policy.md')
    await assert.rejects(readSourceInstructions({ root: workspace, stopAt: root }), /Imported CLAUDE.md/)
    await writeFile(join(workspace, 'CLAUDE.md'), 'See @README for project details')
    await assert.rejects(readSourceInstructions({ root: workspace, stopAt: root }), /Imported CLAUDE.md/)
    await writeFile(join(workspace, 'CLAUDE.md'), 'Examples: `@README` and `` @docs/policy.md ``\n\n```md\n@README\n```\n~~~\n@docs/policy.md\n~~~')
    const literal = await readSourceInstructions({ root: workspace, stopAt: root })
    assert.match(literal.at(-1).content, /@README/)
    await writeFile(join(workspace, 'CLAUDE.md'), 'Example `@README` and real @docs/policy.md')
    await assert.rejects(readSourceInstructions({ root: workspace, stopAt: root }), /Imported CLAUDE.md/)
    await assert.rejects(readSourceInstructions({ root: workspace, stopAt: tmpdir(), maxFileBytes: 4 }), /size limit/)
  } finally {
    const actual = await realpath(root)
    const local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-instructions-')) await rm(actual, { recursive: true, force: true })
  }
})
