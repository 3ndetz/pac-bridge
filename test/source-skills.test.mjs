import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
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
