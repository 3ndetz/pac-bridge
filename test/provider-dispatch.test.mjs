import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('new runner children use the current version and preserve arguments and notification routing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-dispatch-')), pac = join(root, '.hapi-servermall', 'pac-bridge')
  const revision = 'a'.repeat(40), version = join(pac, 'provider-versions', revision)
  await mkdir(join(version, 'adapters'), { recursive: true }); await mkdir(join(pac, 'notify'), { recursive: true })
  const sender = join(root, 'sender.cjs'); await writeFile(sender, '')
  await writeFile(join(pac, 'notify', 'codex-telegram-module.txt'), sender)
  await writeFile(join(pac, 'provider-current.json'), JSON.stringify({ revision, namedProviders: true, legacyMigration: true }))
  await writeFile(join(version, 'adapters', 'pac-hapi-opencode.mjs'), 'console.log(JSON.stringify({args:process.argv.slice(2),named:process.env.PAC_NAMED_PROVIDERS_EXPERIMENT,legacy:process.env.PAC_LEGACY_MIGRATION_EXPERIMENT,notify:process.env.PAC_TURN_NOTIFY_SCRIPT,module:process.env.PAC_CODEX_TELEGRAM_MODULE}))')
  const dispatch = fileURLToPath(new URL('../adapters/provider-dispatch.mjs', import.meta.url))
  const child = spawn(process.execPath, [dispatch, 'acp', '--test'], { env: { ...process.env, HOME: root, USERPROFILE: root }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let out = '', err = ''; child.stdout.on('data', x => { out += x }); child.stderr.on('data', x => { err += x })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  assert.equal(code, 0, err)
  const result = JSON.parse(out)
  assert.deepEqual(result.args, ['acp', '--test'])
  assert.equal(result.named, '1'); assert.equal(result.legacy, '1'); assert.equal(result.module, sender)
  assert.equal(result.notify, join(version, 'adapters', 'codex-telegram-notify.cjs'))
  await writeFile(join(pac, 'provider-current.json'), JSON.stringify({ revision: '../outside', namedProviders: true, legacyMigration: true }))
  const invalid = spawn(process.execPath, [dispatch, 'acp'], { env: { ...process.env, HOME: root, USERPROFILE: root }, stdio: 'ignore', windowsHide: true })
  const invalidCode = await new Promise((resolve, reject) => { invalid.once('error', reject); invalid.once('exit', resolve) })
  assert.notEqual(invalidCode, 0)
})
