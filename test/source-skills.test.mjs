import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, rmdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import test from 'node:test'
import { createSourceSkills } from '../src/source-skills.mjs'

test('discovers and invokes simple source skills without accepting unsupported features', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-skills-'))
  try {
    assert.deepEqual((await createSourceSkills({ root })).list, [])
    const directory = join(root, '.claude', 'skills', 'demo')
    await mkdir(directory, { recursive: true })
    const path = join(directory, 'SKILL.md')
    await writeFile(path, '---\nname: demo\ndescription: A simple test skill\n---\n\nPerform $ARGUMENTS.\n')
    const skills = await createSourceSkills({ root })
    assert.deepEqual(skills.list, [{ name: 'demo', description: 'A simple test skill' }])
    assert.match((await skills.invoke({ name: 'demo', args: 'the task' })).content, /Perform the task/)
    assert.match((await skills.invoke({ name: '/demo', args: 'the task' })).content, /Perform the task/)
    await writeFile(path, '---\nname: demo\ndescription: A skill\n---\nLiteral \\$ARGUMENTS, expanded $ARGUMENTS, other $ARGUMENTS_suffix.')
    const escaped = await createSourceSkills({ root })
    const expanded = (await escaped.invoke({ name: 'demo', args: '$ARGUMENTS value' })).content
    assert.match(expanded, /Literal \$ARGUMENTS, expanded \$ARGUMENTS value, other \$ARGUMENTS_suffix/)
    await assert.rejects(skills.invoke({ name: 'missing' }), /Unknown/)
    await writeFile(path, '---\nname: demo\ndescription: A skill\ncontext: fork\n---\nBody')
    await assert.rejects(createSourceSkills({ root }), /Unsupported skill frontmatter/)
    await writeFile(path, '---\nname: demo\ndescription: A skill\n---\n!`echo hidden`')
    await assert.rejects(createSourceSkills({ root }), /Unsupported dynamic/)
    if (process.platform !== 'win32') {
      await rm(path)
      await symlink(join(tmpdir(), 'outside-skill'), path)
      await assert.rejects(createSourceSkills({ root }), /Symbolic skill files/)
    }
  } finally {
    const actual = await realpath(root)
    const local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-skills-')) await rm(actual, { recursive: true, force: true })
  }
})


test('discovers supported skills from project OpenCode and agents directories and rejects duplicates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-skills-'))
  try {
    for (const [parent, name] of [['.opencode/skill', 'one'], ['.opencode/skills', 'two'], ['.agents/skills', 'three']]) {
      const directory = join(root, parent, name)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: test ${name}\n---\nuse $ARGUMENTS`)
    }
    const skills = await createSourceSkills({ root })
    assert.deepEqual(skills.list.map((item) => item.name).sort(), ['one', 'three', 'two'])
    assert.match((await skills.invoke({ name: 'two', args: 'source' })).content, /use source/)
    const duplicate = join(root, '.claude', 'skills', 'one')
    await mkdir(duplicate, { recursive: true })
    await writeFile(join(duplicate, 'SKILL.md'), '---\nname: one\ndescription: duplicate\n---\nBody')
    await assert.rejects(createSourceSkills({ root }), /Duplicate source skill/)
  } finally {
    const actual = await realpath(root)
    const local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-skills-')) await rm(actual, { recursive: true, force: true })
  }
})

test('discovers global skills with project precedence and parses folded descriptions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-skills-'))
  try {
    const workspace = join(root, 'workspace'), home = join(root, 'home')
    const project = join(workspace, '.opencode', 'skills', 'same')
    const global = join(home, '.config', 'opencode', 'skills', 'same')
    const extra = join(home, '.agents', 'skills', 'extra')
    for (const path of [project, global, extra]) await mkdir(path, { recursive: true })
    await writeFile(join(project, 'SKILL.md'), '---\nname: same\ndescription: project version\n---\nproject')
    await writeFile(join(global, 'SKILL.md'), '---\nname: same\ndescription: global version\n---\nglobal')
    await writeFile(join(extra, 'SKILL.md'), '---\nname: extra\ndescription: >\n  Folded skill description.\n---\nextra')
    const skills = await createSourceSkills({ root: workspace, home })
    assert.deepEqual(skills.list.map((skill) => skill.name).sort(), ['extra', 'same'])
    assert.match((await skills.invoke({ name: 'same' })).content, /project/)
    assert.equal(skills.rootFor('extra'), await realpath(extra))
  } finally {
    const actual = await realpath(root)
    const local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-skills-')) await rm(actual, { recursive: true, force: true })
  }
})

test('discovers nested skills and accepts literal examples without executing substitutions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-skills-'))
  try {
    const folder = join(root, '.claude', 'skills', 'synced', '123', 'nested')
    await mkdir(folder, { recursive: true })
    const path = join(folder, 'SKILL.md')
    await writeFile(path, '---\nname: nested\ndescription: Nested skill\nlicense: MIT\ncompatibility: OpenCode\n---\n`$2`\n```sh\n!`echo example`\n${HOME}\n```\n')
    const skills = await createSourceSkills({ root })
    assert.deepEqual(skills.list.map((skill) => skill.name), ['nested'])
    assert.match((await skills.invoke({ name: 'nested' })).content, /\$2/)
    await writeFile(path, '---\nname: nested\ndescription: Nested skill\n---\nRun !`echo unsafe`')
    await assert.rejects(createSourceSkills({ root }), /Unsupported dynamic/)
    await writeFile(path, '---\nname: nested\ndescription: Nested skill\n---\nValue $2')
    await assert.rejects(createSourceSkills({ root }), /Unsupported dynamic/)
    await assert.rejects(createSourceSkills({ root, maxSkills: 2 }), /entry limit/)
  } finally {
    const actual = await realpath(root)
    const local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-skills-')) await rm(actual, { recursive: true, force: true })
  }
})

test('exposes built-in skill content without granting a filesystem root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-skills-'))
  try {
    const builtins = [{ name: 'built-in', description: 'Built-in skill', content: 'Literal $ARGUMENTS and !`example`' }]
    const skills = await createSourceSkills({ root, builtins })
    assert.deepEqual(skills.list, [{ name: 'built-in', description: 'Built-in skill' }])
    assert.equal(skills.rootFor('built-in'), null)
    assert.match((await skills.invoke({ name: 'built-in', args: 'request' })).content, /Literal \$ARGUMENTS and !`example`[\s\S]*ARGUMENTS: request/)
    await assert.rejects(createSourceSkills({ root, builtins: [{ ...builtins[0], name: '../outside' }] }), /Invalid built-in/)
    const folder = join(root, '.opencode', 'skills', 'built-in')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'SKILL.md'), '---\nname: built-in\ndescription: Local override\n---\nLocal content')
    const overridden = await createSourceSkills({ root, builtins })
    assert.match((await overridden.invoke({ name: 'built-in' })).content, /Local content/)
    assert.equal(overridden.rootFor('built-in'), await realpath(folder))
  } finally {
    const actual = await realpath(root)
    const local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-skills-')) await rm(actual, { recursive: true, force: true })
  }
})

test('loads nearest ancestor project skills up to the git boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-skills-'))
  try {
    const project = join(root, 'project'), child = join(project, 'nested', 'work')
    for (const [base, name, text] of [[root, 'outside', 'Outside'], [project, 'parent', 'Parent'], [project, 'same', 'Parent version'], [child, 'same', 'Child version']]) {
      const folder = join(base, '.opencode', 'skills', name)
      await mkdir(folder, { recursive: true })
      await writeFile(join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: Test ${name}\n---\n${text}`)
    }
    await mkdir(join(project, '.git'))
    const skills = await createSourceSkills({ root: child })
    assert.deepEqual(skills.list.map((item) => item.name).sort(), ['parent', 'same'])
    assert.match((await skills.invoke({ name: 'same' })).content, /Child version/)
    assert.equal(skills.rootFor('parent'), await realpath(join(project, '.opencode', 'skills', 'parent')))
    await rmdir(join(project, '.git'))
    const noGit = await createSourceSkills({ root: child })
    assert.ok(noGit.list.some((item) => item.name === 'outside'))
  } finally {
    const actual = await realpath(root)
    const local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-skills-')) await rm(actual, { recursive: true, force: true })
  }
})

test('treats home compatibility directories as global when home is the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-skills-'))
  const home = join(root, 'home')
  try {
    const outside = join(root, '.opencode', 'skills', 'outside')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'SKILL.md'), '---\nname: outside\ndescription: Outside home\n---\nOutside')
    for (const parent of ['.agents', '.claude']) {
      const folder = join(home, parent, 'skills', 'same')
      await mkdir(folder, { recursive: true })
      await writeFile(join(folder, 'SKILL.md'), `---\nname: same\ndescription: ${parent}\n---\n${parent}`)
    }
    const skills = await createSourceSkills({ root: home, home })
    assert.equal(skills.list.length, 1)
    assert.match((await skills.invoke({ name: 'same' })).content, /\.agents/)
  } finally {
    const actual = await realpath(root)
    const local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-skills-')) await rm(actual, { recursive: true, force: true })
  }
})
