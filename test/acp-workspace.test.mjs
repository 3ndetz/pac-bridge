import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createWorkspace } from '../src/acp-workspace.mjs'

test('handles ACP read/write commands on the selected workspace and session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-workspace-'))
  try {
    const path = join(root, 'file.txt')
    await writeFile(path, 'first\r\nsecond\nthird')
    const workspace = await createWorkspace({ root, sessionId: 'client-1' })
    assert.deepEqual(await workspace.readTextFile({ sessionId: 'client-1', path, line: 2, limit: 1 }), { content: 'second\n' })
    assert.deepEqual(await workspace.readTextFile({ sessionId: 'client-1', path: 'file.txt', line: 2, limit: 1 }), { content: 'second\n' })
    await workspace.writeTextFile({ sessionId: 'client-1', path: 'file.txt', content: 'relative' })
    assert.equal(await readFile(path, 'utf8'), 'relative')
    await workspace.writeTextFile({ sessionId: 'client-1', path, content: 'updated' })
    assert.equal(await readFile(path, 'utf8'), 'updated')
    await assert.rejects(workspace.readTextFile({ sessionId: 'client-2', path }), /session/)
    await assert.rejects(workspace.readTextFile({ sessionId: 'client-1', path: join(root, '..', 'outside') }), /outside/)
    await assert.rejects(workspace.writeTextFile({ sessionId: 'client-1', path: '../outside', content: 'x' }), /outside/)
    await assert.rejects(workspace.readTextFile({ sessionId: 'client-1', path, line: 0 }), /Invalid line/)
    const bounded = await createWorkspace({ root, sessionId: 'client-1', maxBytes: 3 })
    await assert.rejects(bounded.readTextFile({ sessionId: 'client-1', path }), /limit/)
    await assert.rejects(bounded.writeTextFile({ sessionId: 'client-1', path, content: 'large' }), /limit/)
    await writeFile(path, Buffer.from([0xff]))
    await assert.rejects(workspace.readTextFile({ sessionId: 'client-1', path }))
    await assert.rejects(workspace.readImageFile({ sessionId: 'client-1', path }), /Unsupported image/)
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/3ZYAAAAASUVORK5CYII=', 'base64')
    await writeFile(path, image)
    assert.deepEqual(await workspace.readImageFile({ sessionId: 'client-1', path }), { data: image.toString('base64'), mimeType: 'image/png' })
    await assert.rejects(workspace.readImageFile({ sessionId: 'client-2', path }), /session/)
    await assert.rejects(bounded.readImageFile({ sessionId: 'client-1', path }), /limit/)
    for (const [bytes, mimeType] of [[Buffer.from([255, 216, 255]), 'image/jpeg'], [Buffer.from('GIF89a'), 'image/gif'], [Buffer.from('RIFF0000WEBP'), 'image/webp']]) {
      await writeFile(path, bytes)
      assert.equal((await workspace.readImageFile({ sessionId: 'client-1', path })).mimeType, mimeType)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('rejects file symlinks that resolve outside the workspace', { skip: process.platform === 'win32' }, async () => {
  const base = await mkdtemp(join(tmpdir(), 'pac-link-'))
  try {
    const root = join(base, 'root')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(root)
    await writeFile(join(base, 'outside'), 'private')
    await symlink(join(base, 'outside'), join(root, 'link'))
    const workspace = await createWorkspace({ root, sessionId: 'session' })
    await assert.rejects(workspace.readTextFile({ sessionId: 'session', path: join(root, 'link') }), /outside/)
    await assert.rejects(workspace.writeTextFile({ sessionId: 'session', path: join(root, 'link'), content: 'x' }), /outside/)
    assert.equal(await readFile(join(base, 'outside'), 'utf8'), 'private')
    await symlink(join(base, 'not-created'), join(root, 'dangling'))
    await assert.rejects(workspace.writeTextFile({ sessionId: 'session', path: join(root, 'dangling'), content: 'x' }), /symbolic/)
  } finally { await rm(base, { recursive: true, force: true }) }
})

test('rejects Windows junctions that resolve outside the workspace', { skip: process.platform !== 'win32' }, async () => {
  const base = await mkdtemp(join(tmpdir(), 'pac-junction-'))
  try {
    const { mkdir } = await import('node:fs/promises')
    const root = join(base, 'root')
    const outside = join(base, 'outside')
    await mkdir(root)
    await mkdir(outside)
    await writeFile(join(outside, 'file'), 'private')
    await symlink(outside, join(root, 'link'), 'junction')
    const workspace = await createWorkspace({ root, sessionId: 'session' })
    await assert.rejects(workspace.readTextFile({ sessionId: 'session', path: join(root, 'link', 'file') }), /outside/)
    await assert.rejects(workspace.writeTextFile({ sessionId: 'session', path: join(root, 'link', 'new'), content: 'x' }), /outside/)
  } finally { await rm(base, { recursive: true, force: true }) }
})
