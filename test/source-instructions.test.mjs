import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import test from 'node:test'
import { readSourceInstructions } from '../src/source-instructions.mjs'

test('reads instructions and workspace imports, preserving boundaries and code examples', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-instructions-'))
  try {
    const workspace = join(root, 'nested')
    await mkdir(workspace)
    await writeFile(join(root, 'AGENTS.md'), 'Parent instruction')
    await writeFile(join(workspace, 'CLAUDE.md'), 'Project instruction')
    const entries = await readSourceInstructions({ root: workspace, stopAt: root })
    assert.deepEqual(entries.map((entry) => entry.content), ['Parent instruction', 'Project instruction'])
    await mkdir(join(workspace, 'docs'))
    await writeFile(join(workspace, 'docs', 'policy.md'), 'Policy @extra.md')
    await writeFile(join(workspace, 'docs', 'extra.md'), 'Extra')
    await writeFile(join(workspace, 'CLAUDE.md'), 'See @docs/policy.md')
    assert.deepEqual((await readSourceInstructions({ root: workspace, stopAt: root })).map((entry) => entry.content),
      ['Parent instruction', 'See @docs/policy.md', 'Policy @extra.md', 'Extra'])
    await writeFile(join(workspace, 'README'), 'Readme')
    await writeFile(join(workspace, 'CLAUDE.md'), 'See @README for project details')
    assert.equal((await readSourceInstructions({ root: workspace, stopAt: root })).at(-1).content, 'Readme')
    await writeFile(join(workspace, 'docs', 'team rules.md'), 'Team rules')
    await writeFile(join(workspace, 'CLAUDE.md'), 'See @docs/team\\ rules.md')
    assert.equal((await readSourceInstructions({ root: workspace, stopAt: root })).at(-1).content, 'Team rules')
    await writeFile(join(workspace, 'CLAUDE.md'), 'Examples: `@README` and `` @docs/policy.md ``\n\n```md\n@README\n```\n~~~\n@docs/policy.md\n~~~')
    const literal = await readSourceInstructions({ root: workspace, stopAt: root })
    assert.match(literal.at(-1).content, /@README/)
    await writeFile(join(workspace, 'CLAUDE.md'), 'Example `@README` and real @docs/policy.md')
    assert.equal((await readSourceInstructions({ root: workspace, stopAt: root })).at(-1).content, 'Extra')
    await writeFile(join(workspace, 'CLAUDE.md'), 'External @../AGENTS.md')
    await assert.rejects(readSourceInstructions({ root: workspace, stopAt: root }), /External instruction imports/)
    await writeFile(join(workspace, 'CLAUDE.md'), 'Cycle @docs/policy.md')
    await writeFile(join(workspace, 'docs', 'extra.md'), 'Cycle @policy.md')
    await assert.rejects(readSourceInstructions({ root: workspace, stopAt: root }), /Cyclic instruction import/)
    for (let i = 0; i < 5; i++) await writeFile(join(workspace, 'docs', `${i}.md`), `@${i + 1}.md`)
    await writeFile(join(workspace, 'CLAUDE.md'), '@docs/0.md')
    await assert.rejects(readSourceInstructions({ root: workspace, stopAt: root }), /maximum depth/)
    await assert.rejects(readSourceInstructions({ root: workspace, stopAt: tmpdir(), maxFileBytes: 4 }), /size limit/)
  } finally {
    const actual = await realpath(root)
    const local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-instructions-')) await rm(actual, { recursive: true, force: true })
  }
})
