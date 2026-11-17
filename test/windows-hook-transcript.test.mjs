import assert from 'node:assert/strict'
import { access, readFile, open, rename, link, mkdtemp, rm, mkdir, writeFile, realpath, readdir, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename, dirname, relative } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { createProjectHooks } from '../src/project-hooks.mjs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { withWindowsHookTranscript, snapshotWindowsHookTranscript } from '../src/windows-hook-transcript.mjs'
const windows = process.platform === 'win32'

test('Windows private transcript is readable only during its owned callback and is removed afterwards', { skip: !windows, timeout: 30000 }, async () => {
  let path
  const encoded = Buffer.from('SYNTHETIC_PRIVATE_TRANSCRIPT').toString('base64')
  await withWindowsHookTranscript(encoded, async value => {
    path = value
    assert.equal(await readFile(path, 'utf8'), 'SYNTHETIC_PRIVATE_TRANSCRIPT')
    await assert.rejects(writeFile(path, 'REPLACEMENT'))
    await assert.rejects(rename(dirname(path), dirname(path) + '-moved'))
  })
  await assert.rejects(access(path), { code: 'ENOENT' })
  await assert.rejects(access(join(path, '..')), { code: 'ENOENT' })
})

test('Windows private transcript validates encoding before invoking a callback', { skip: !windows }, async () => {
  for (const input of ['?', 'AB==', Buffer.alloc(1024 * 1024 + 1).toString('base64')]) await assert.rejects(withWindowsHookTranscript(input, () => assert.fail('invalid transcript callback')), /Invalid/)
})

test('Windows private transcript is removed after its callback fails', { skip: !windows, timeout: 20000 }, async () => {
  let path
  await assert.rejects(withWindowsHookTranscript('', async value => { path = value; throw new Error('synthetic callback failure') }), /synthetic callback failure/)
  await assert.rejects(access(path), { code: 'ENOENT' })
})


test('Windows snapshot reads an owned private file and rejects broad ACLs, oversize and hard links', { skip: !windows, timeout: 45000 }, async () => {
  const script = fileURLToPath(new URL('./fixtures/windows-private-transcript.ps1', import.meta.url))
  for (const mode of ['private', 'token-owner', 'broad', 'large']) {
    const root = await mkdtemp(join(tmpdir(), 'pac-win-snapshot-'))
    try {
      await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Root', root, '-Mode', mode], { timeout: 10000, windowsHide: true })
      const path = join(root, 'session.jsonl')
      if (mode === 'private' || mode === 'token-owner') {
        assert.equal(await snapshotWindowsHookTranscript(path, { root, sessionId: 'session' }), Buffer.from('SYNTHETIC_PRIVATE_TRANSCRIPT').toString('base64'))
        const writer = await open(path, 'r+')
        try { await assert.rejects(snapshotWindowsHookTranscript(path, { root, sessionId: 'session' }), { code: 'PAC_PRIVATE_TRANSCRIPT_32' }) } finally { await writer.close() }
        const linked = join(root, 'other.jsonl'); await link(path, linked)
        await assert.rejects(snapshotWindowsHookTranscript(linked, { root, sessionId: 'other' }), /unavailable/)
      } else await assert.rejects(snapshotWindowsHookTranscript(path, { root, sessionId: 'session' }), /unavailable/)
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 5 }) }
  }
})


test('Windows Stop hook reads its private transcript through the real source hook executor', { skip: !windows, timeout: 25000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-win-stop-hook-'))
  try {
    await mkdir(join(root, '.claude'))
    const script = `let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{const path=JSON.parse(input).transcript_path;if(require('node:fs').readFileSync(path,'utf8')!=='SYNTHETIC_STOP_TRANSCRIPT')process.exit(1);process.stdout.write(JSON.stringify({decision:'block',reason:'synthetic stop'}))})`
    await writeFile(join(root, '.claude/settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: process.execPath, args: ['-e', script] }] }] } }))
    const hooks = await createProjectHooks({ root, home: root, shell: process.execPath })
    const result = await withWindowsHookTranscript(Buffer.from('SYNTHETIC_STOP_TRANSCRIPT').toString('base64'), transcript_path => hooks.dispatch({ hook_event_name: 'Stop', stop_hook_active: false, transcript_path }))
    assert.deepEqual(result, { decision: 'block', reason: 'synthetic stop' })
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5 }) }
})


test('Windows private transcript disappears on parent loss and its test job drains before cleanup', { skip: !windows, timeout: 60000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pac-win-transcript-crash-')))
  const nonce = (await import('node:crypto')).randomBytes(16).toString('hex')
  const module = new URL('../src/windows-hook-transcript.mjs', import.meta.url).href
  const ready = join(root, 'ready.json'), die = join(root, 'die.signal')
  const script = `const fs=await import('node:fs/promises');const {withWindowsHookTranscript}=await import(${JSON.stringify(module)});await withWindowsHookTranscript(Buffer.from('SYNTHETIC_CRASH_TRANSCRIPT').toString('base64'),async path=>{await fs.writeFile(${JSON.stringify(ready)},JSON.stringify({path}),{flag:'wx'});setInterval(async()=>{try{if(await fs.readFile(${JSON.stringify(die)},'utf8')===${JSON.stringify(nonce)})process.exit(0)}catch{}},50);await new Promise(()=>{})});`
  const env = { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: root, TMP: root, USERPROFILE: root, HOME: root, APPDATA: join(root,'roaming'), LOCALAPPDATA: join(root,'local'), PSModuleAnalysisCachePath: 'NUL' }
  const spec = Buffer.from(JSON.stringify({ command: process.execPath, args: ['--input-type=module','-e',script], cwd: root, nonce, deadlineMs: 45000 })).toString('base64')
  const fixture = fileURLToPath(new URL('./fixtures/windows-test-owned-job-host.ps1', import.meta.url))
  const host = spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fixture,spec],{env,stdio:['ignore','pipe','ignore'],windowsHide:true})
  let output = ''
  host.stdout.on('data', bytes => { output += bytes.toString('utf8') })
  const closed = once(host,'close')
  async function until(run, milliseconds) {
    const deadline=Date.now()+milliseconds
    while (true) { if(await run()) return; if(Date.now()>=deadline) throw new Error('Synthetic private transcript deadline exceeded'); await new Promise(resolve=>setTimeout(resolve,50)) }
  }
  try {
    await until(async()=>{try{await access(ready);return true}catch(error){if(error.code!=='ENOENT')throw error;return false}},20000)
    const {path}=JSON.parse(await readFile(ready,'utf8'))
    assert.equal(basename(path),'transcript.jsonl')
    assert.match(basename(dirname(path)),/^pac-hook-transcript-[a-f0-9]{32}$/)
    assert.equal(relative(root,dirname(dirname(path))),'')
    assert.equal(await readFile(path,'utf8'),'SYNTHETIC_CRASH_TRANSCRIPT')
    await writeFile(die,nonce,{flag:'wx'})
    await until(async()=>{try{await access(path);return false}catch(error){if(error.code!=='ENOENT')throw error;return true}},8000)
  } finally {
    await writeFile(join(root,'stop.signal'),nonce)
    let timer
    try {
      const [code]=await Promise.race([closed,new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Synthetic transcript job drain unconfirmed')),20000)})])
      assert.equal(code,0)
      assert.ok(output.includes('OWNED_CLOSED '+nonce),'Synthetic transcript job drain unconfirmed')
      assert.equal(dirname(root),await realpath(tmpdir()))
      assert.match(basename(root),/^pac-win-transcript-crash-/)
      async function verify(directory) {
        for(const entry of await readdir(directory,{withFileTypes:true})) {
          const path=join(directory,entry.name)
          assert.equal(entry.isSymbolicLink(),false,'Unexpected reparse path in synthetic transcript workspace')
          if(entry.isDirectory()) await verify(path)
        }
      }
      await verify(root)
      await rm(root,{recursive:true,force:true,maxRetries:5})
    } finally { clearTimeout(timer) }
  }
})

test('Windows transcript snapshot rejects a reparse ancestor', { skip: !windows, timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pac-win-transcript-link-')), target = join(root, 'private'), junction = join(root, 'junction')
  try {
    await mkdir(target)
    const script = fileURLToPath(new URL('./fixtures/windows-private-transcript.ps1', import.meta.url))
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Root', target], { timeout: 10000, windowsHide: true })
    await symlink(target, junction, 'junction')
    await assert.rejects(snapshotWindowsHookTranscript(join(junction, 'session.jsonl'), { root: junction, sessionId: 'session' }), /unavailable/)
  } finally { try { await unlink(junction) } catch (error) { if (error.code !== 'ENOENT') throw error }; await rm(root, { recursive: true, force: true, maxRetries: 5 }) }
})
