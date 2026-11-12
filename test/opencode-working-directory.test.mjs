import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { normalizeOpencodeWorkingDirectory, opencodeWorkingDirectory } from '../src/opencode-working-directory.mjs'

test('uses the OpenCode ACP working directory supplied by HAPI', () => {
  const inherited = process.cwd(), requested = resolve(inherited, 'project')
  assert.equal(opencodeWorkingDirectory(['acp', '--cwd', requested, '--port', '123'], inherited), requested)
  assert.equal(opencodeWorkingDirectory(['acp', `--cwd=${requested}`], inherited), requested)
  assert.equal(opencodeWorkingDirectory(['acp', '--cwd', 'project'], inherited), requested)
  assert.deepEqual(normalizeOpencodeWorkingDirectory(['acp', '--cwd', 'project'], requested), ['acp', '--cwd', requested])
  assert.deepEqual(normalizeOpencodeWorkingDirectory(['acp', '--cwd=project'], requested), ['acp', `--cwd=${requested}`])
  assert.equal(opencodeWorkingDirectory(['acp'], inherited), inherited)
  assert.equal(opencodeWorkingDirectory(['serve', '--cwd', requested], inherited), inherited)
  assert.throws(() => opencodeWorkingDirectory(['acp', '--cwd'], inherited), /Missing/)
  assert.throws(() => opencodeWorkingDirectory(['acp', '--cwd', requested, '--cwd', requested], inherited), /Duplicate/)
})
