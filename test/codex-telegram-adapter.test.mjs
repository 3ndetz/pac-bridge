import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('forwards a completion to the existing local sender without copying credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-codex-notify-'))
  const sender = join(root, 'sender.cjs'), result = join(root, 'result.json')
  await writeFile(sender, `exports.notify = async event => require('node:fs').writeFileSync(${JSON.stringify(result)}, JSON.stringify(event))`)
  const adapter = fileURLToPath(new URL('../adapters/codex-telegram-notify.cjs', import.meta.url))
  const child = spawn(process.execPath, [adapter], { env: { ...process.env, PAC_CODEX_TELEGRAM_MODULE: sender }, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
  const event = { hook_event_name: 'Stop', session_id: 'session', turn_id: 'turn', last_assistant_message: 'test answer' }
  child.stdin.end(JSON.stringify(event))
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(await readFile(result, 'utf8')), event)
})
