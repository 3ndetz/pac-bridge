import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import test from 'node:test'
import { assertNoUnsupportedOpenCodePlugins } from '../src/opencode-plugin-guard.mjs'

test('blocks configured OpenCode plugins without mistaking JSONC strings for comments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-plugin-guard-'))
  try {
    const workspace = join(root, 'workspace'), home = join(root, 'home')
    await mkdir(workspace); await mkdir(join(home, '.config', 'opencode'), { recursive: true })
    const config = join(home, '.config', 'opencode', 'opencode.jsonc')
    await writeFile(config, '{ "url": "https://example.test/a,//b", "plugin": [], // comment\n }')
    await assertNoUnsupportedOpenCodePlugins({ root: workspace, home, env: {} })
    await writeFile(config, '{ "plugin": ["example-plugin", /* comment */], }')
    await assert.rejects(assertNoUnsupportedOpenCodePlugins({ root: workspace, home, env: {} }), /plugins and hooks are not yet supported/)
    for (const item of ['"permission": {"bash": "deny"}', '"instructions": ["custom.md"]', '"mcp": {"example": {}}', '"skills": {"paths": ["custom"]}', '"agent": {"build": {"permission": {"bash": "deny"}}}']) {
      await writeFile(config, `{ ${item} }`)
      await assert.rejects(assertNoUnsupportedOpenCodePlugins({ root: workspace, home, env: {} }), /configuration is not yet supported/)
    }
    await writeFile(config, '{ "plugin": [], // trailing comment\n }')
    const plugins = join(workspace, '.opencode', 'plugin')
    await mkdir(plugins, { recursive: true })
    await writeFile(join(plugins, 'hook.js'), 'export default () => ({})')
    await assert.rejects(assertNoUnsupportedOpenCodePlugins({ root: workspace, home, env: {} }), /plugins and hooks are not yet supported/)
    await assert.rejects(assertNoUnsupportedOpenCodePlugins({ root: workspace, home, env: { OPENCODE_CONFIG_CONTENT: '{"plugin": ["another"]}' } }), /plugins and hooks are not yet supported/)
  } finally {
    const actual = await realpath(root), local = relative(await realpath(tmpdir()), actual)
    if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-plugin-guard-')) await rm(actual, { recursive: true, force: true })
  }
})
