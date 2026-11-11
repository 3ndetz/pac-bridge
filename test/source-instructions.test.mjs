import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
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
    await writeFile(join(workspace, 'CLAUDE.local.md'), 'Personal @README')
    const personal = await readSourceInstructions({ root: workspace, stopAt: root })
    assert.deepEqual(personal.slice(-2).map((entry) => entry.content), ['Personal @README', 'Readme'])
    await unlink(join(workspace, 'CLAUDE.local.md'))
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

test('rejects a linked project rule directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-rule-link-'))
  try {
    const workspace = join(root, 'workspace')
    const external = join(root, 'external')
    await mkdir(join(workspace, '.claude'), { recursive: true })
    await mkdir(external)
    await symlink(external, join(workspace, '.claude', 'rules'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(readSourceInstructions({ root: workspace, stopAt: workspace }), /Symbolic rule paths/)
  } finally {
    const actual = await realpath(root)
    const local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-rule-link-')) await rm(actual, { recursive: true, force: true })
  }
})

test('loads instructions from directories between the workspace and the accessed file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-nested-instructions-'))
  try {
    await mkdir(join(root, 'src', 'feature'), { recursive: true })
    await writeFile(join(root, 'CLAUDE.md'), 'Root instruction')
    await writeFile(join(root, 'src', 'CLAUDE.md'), 'Source instruction')
    await writeFile(join(root, 'src', 'feature', 'AGENTS.md'), 'Feature instruction')
    await mkdir(join(root, 'src', '.claude', 'rules'), { recursive: true })
    await writeFile(join(root, 'src', '.claude', 'rules', 'scope.md'), '---\npaths: "feature/*.txt"\n---\nNested scoped rule')
    const file = join(root, 'src', 'feature', 'file.txt')
    await writeFile(file, 'File')
    const entries = await readSourceInstructions({ root, nestedTarget: file, nestedOnly: true })
    assert.deepEqual(entries.map((item) => item.content), ['Source instruction', 'Feature instruction', 'Nested scoped rule'])
    assert.deepEqual(entries.at(-1).paths, ['feature/*.txt'])
    assert.equal(entries.at(-1).base, join(await realpath(root), 'src'))
    await assert.rejects(readSourceInstructions({ root, nestedTarget: join(root, '..', 'outside'), nestedOnly: true }))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('loads unscoped and scoped project rules without making scoped content global', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-rules-'))
  try {
    const rules = join(root, '.claude', 'rules')
    await mkdir(join(rules, 'nested'), { recursive: true })
    await writeFile(join(root, 'CLAUDE.md'), 'Project')
    await writeFile(join(rules, 'nested', 'style.md'), 'Use project style')
    assert.deepEqual((await readSourceInstructions({ root, stopAt: root })).map((item) => item.content),
      ['Project', 'Use project style'])
    await writeFile(join(rules, 'nested', 'style.md'), '---\npaths: "src/**"\n---\nScoped rule')
    const entries = await readSourceInstructions({ root, stopAt: root })
    assert.deepEqual(entries.at(-1), { path: join(await realpath(root), '.claude', 'rules', 'nested', 'style.md'), paths: ['src/**'], content: 'Scoped rule' })
    assert.deepEqual(entries.filter((entry) => !entry.paths).map((entry) => entry.content), ['Project'])
    await writeFile(join(rules, 'nested', 'style.md'), `---\npaths: "src/**"\n---\n${'x'.repeat(22000)}`)
    assert.equal((await readSourceInstructions({ root, stopAt: root })).at(-1).content.length, 22000)
    await writeFile(join(rules, 'nested', 'style.md'), `---\npaths: "src/**"\n---\n${'x'.repeat(140000)}`)
    await writeFile(join(rules, 'nested', 'extra.md'), `---\npaths: "src/**"\n---\n${'y'.repeat(140000)}`)
    await assert.rejects(readSourceInstructions({ root, stopAt: root }), /Scoped instructions exceed/)
  } finally {
    const actual = await realpath(root)
    const local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-rules-')) await rm(actual, { recursive: true, force: true })
  }
})
