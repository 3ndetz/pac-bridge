import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { notifyTurnComplete } from '../src/completion-notifier.mjs'

test('passes a bounded completion event over stdin to the configured sender', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-notify-test-'))
  const script = join(root, 'sender.cjs'), output = join(root, 'event.json')
  try {
    await writeFile(script, `let s='';process.stdin.on('data',v=>s+=v);process.stdin.on('end',()=>require('fs').writeFileSync(${JSON.stringify(output)},s));`)
    assert.equal(notifyTurnComplete({ script, sessionId: 'session', turnId: 'turn', cwd: root, message: 'A'.repeat(2000) }), true)
    let event
    for (let attempt = 0; attempt < 100; attempt++) {
      try { event = JSON.parse(await readFile(output, 'utf8')); break } catch { await new Promise((resolve) => setTimeout(resolve, 50)) }
    }
    assert.equal(event.hook_event_name, 'Stop')
    assert.equal(event.turn_id, 'turn')
    assert.equal(event.last_assistant_message.length, 1800)
    assert.equal(notifyTurnComplete({ script: 'relative.cjs', sessionId: 's', turnId: 't', cwd: root, message: '' }), false)
    assert.equal(notifyTurnComplete({ script: '', sessionId: 's', turnId: 't', cwd: root, message: '' }), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
