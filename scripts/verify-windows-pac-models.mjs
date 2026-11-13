import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'

// This is a paid, real-model check. It creates one disposable HAPI session.
if (process.platform !== 'win32' || process.env.PAC_TEST_INSTALLED !== '1') throw new Error('Windows and explicit PAC_TEST_INSTALLED=1 opt-in are required')
const home = homedir(), root = join(home, 'sma-test', `pac-model-matrix-${randomUUID()}`)
if ([process.execPath, root].some(value => /[%"\r\n]/.test(value))) throw new Error('The temporary Windows launcher path contains unsupported characters')
await mkdir(root, { recursive: true })
const launcher = join(root, 'pac-silent-launcher.mjs'), proof = join(root, 'launcher-proof.log')
const source = `import {readFile,appendFile} from 'node:fs/promises';import {homedir} from 'node:os';import {join} from 'node:path';import {pathToFileURL} from 'node:url';const home=join(homedir(),'.hapi-servermall','pac-bridge');const p=JSON.parse((await readFile(join(home,'provider-current.json'),'utf8')).replace(/^\\uFEFF/,''));if(!/^[a-f0-9]{40}$/.test(p.revision))throw Error('Invalid installed revision');const version=join(home,'provider-versions',p.revision);process.env.PAC_HAPI_PROVIDER_EXPERIMENT='1';for(const [k,v] of [['PAC_NAMED_PROVIDERS_EXPERIMENT',p.namedProviders],['PAC_LEGACY_MIGRATION_EXPERIMENT',p.legacyMigration]]){if(v)process.env[k]='1';else delete process.env[k]}delete process.env.PAC_TURN_NOTIFY_SCRIPT;delete process.env.PAC_CODEX_TELEGRAM_MODULE;await appendFile(${JSON.stringify(proof)},String(process.argv[2])+'\\n');await import(pathToFileURL(join(version,'adapters','pac-hapi-opencode.mjs')).href);`
await writeFile(launcher, source)
await writeFile(join(root, 'opencode.cmd'), `@echo off\r\n"${process.execPath}" "${launcher}" %*\r\n`)
const profile = join(home, '.hapi-servermall'), json = async f => JSON.parse((await readFile(join(profile, f), 'utf8')).replace(/^\uFEFF/, ''))
const settings = await json('settings.json'), connection = await json('connection.json'), base = `http://127.0.0.1:${connection.relayPort}`
let jwt, sessionId, spawnAttempted = false, archived = false
async function request(path, method='GET', data) {
 const r = await fetch(base + path, { method, headers: { ...(jwt ? { authorization: `Bearer ${jwt}` } : {}), ...(data ? {'content-type':'application/json'} : {}) }, ...(data ? {body:JSON.stringify(data)} : {}), signal:AbortSignal.timeout(120000) })
 if (!r.ok) throw Object.assign(new Error(`HAPI ${method} ${r.status}`), {status:r.status})
 return r.status===204 ? {} : r.json()
}
async function until(fn, ms=180000) { const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,1000))}throw Error('Timed out waiting for test progress') }
async function send(text) { const body={text,localId:randomUUID()},end=Date.now()+60000;while(true){try{return await request(`/api/sessions/${sessionId}/messages`,'POST',body)}catch(e){if(e.status!==409||Date.now()>end)throw e;await new Promise(r=>setTimeout(r,1000))}} }
async function messages(){return (await request(`/api/sessions/${sessionId}/messages?limit=100`)).messages||[]}
function textOf(m){const d=m.content?.content?.data;return m.content?.role==='agent'&&d?.type==='message'?d.message||'':''}
try {
 jwt=(await request('/api/auth','POST',{accessToken:settings.cliApiToken})).token
 const machine=(await request('/api/machines')).machines.find(x=>x.active&&x.id===settings.machineId);if(!machine)throw Error('Existing runner unavailable')
 const catalog=await request(`/api/machines/${machine.id}/opencode-models?cwd=${encodeURIComponent(root)}`)
 const models=(catalog.availableModels||[]).filter(x=>typeof x.modelId==='string'&&x.modelId.startsWith('PAC_'))
 if(!models.length)throw Error('No PAC models discovered')
 console.log(JSON.stringify({stage:'catalog',count:models.length}))
 spawnAttempted = true
 const created=await request(`/api/machines/${machine.id}/spawn`,'POST',{directory:root,agent:'opencode',model:models[0].modelId,yolo:true,startingMode:'remote'})
 if(created.type!=='success'||!created.sessionId)throw Error('Test session was not created');sessionId=created.sessionId
 await until(async()=>{try{return (await readFile(proof,'utf8')).split(/\r?\n/).includes('acp')}catch{return false}},180000)
 console.log(JSON.stringify({stage:'silent_launcher_verified'}))
 for(let i=0;i<models.length;i++){
  const model=models[i], old=new Set((await messages()).map(m=>m.id))
  if(i>0){await send(`/model ${model.modelId}`);await until(async()=>{const m=(await messages()).filter(x=>!old.has(x.id));return m.some(x=>textOf(x).includes(`OpenCode model set to ${model.modelId}`))},60000)}
  const before=new Set((await messages()).map(m=>m.id)),marker=`PAC_MODEL_MATRIX_${String(i).padStart(2,'0')}_${randomUUID().slice(0,8)}`
  await send(`Reply with only ${marker}. Do not call tools.`)
  await until(async()=>{const recent=(await messages()).filter(x=>!before.has(x.id));if(recent.some(x=>x.content?.role==='agent'&&x.content?.content?.data?.type==='error'))throw Error(`Agent error for ${model.modelId}`);return recent.some(x=>textOf(x).includes(marker))})
  console.log(JSON.stringify({stage:'model_reply',modelId:model.modelId,name:model.name}))
 }
 console.log(JSON.stringify({stage:'complete',models:models.length}))
} catch (error) {
 console.error(`Model check failed: ${error.message}`)
 process.exitCode = 1
} finally {
 if(sessionId&&jwt){try{await request(`/api/sessions/${sessionId}/archive`,'POST')}catch{};try{archived=(await request(`/api/sessions/${sessionId}`)).session?.metadata?.lifecycleState==='archived'}catch{};console.log(JSON.stringify({stage:'cleanup',archived}));if(!archived)process.exitCode=1}
 if (!spawnAttempted || archived) {
  try {
   // Only the exact project created by this invocation may be removed.
   const parent = await realpath(join(home, 'sma-test')), actual = await realpath(root), child = relative(parent, actual)
   if (isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`) || !/^pac-model-matrix-[0-9a-f-]{36}$/i.test(child)) throw Error('Refusing to remove an unexpected test directory')
   await rm(actual, { recursive: true, force: true })
  } catch (error) { console.error(`Test workspace cleanup failed: ${error.message}; inspect ${root}.`); process.exitCode=1 }
 } else { console.error(`Test session cleanup is uncertain; inspect session ${sessionId || 'unknown'} and workspace ${root}.`); process.exitCode=1 }
}
