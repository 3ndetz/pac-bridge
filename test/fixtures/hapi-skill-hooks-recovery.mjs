import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
if (process.env.PAC_TEST_INSTALLED !== '1') throw new Error('Explicit installed-test opt-in required')
const home=homedir(), root=join(home,'sma-test',`pac-context-capabilities-${randomUUID()}`), config=join(root,'.claude'), skill=join(root,'.opencode','skills','pac-proof')
await mkdir(config,{recursive:true}); await mkdir(skill,{recursive:true})
const hook=String.raw`let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{const e=JSON.parse(s);require('fs').appendFileSync(require('path').join(process.env.CLAUDE_PROJECT_DIR,'hook-events.log'),e.hook_event_name+':'+e.tool_name+'\n')})`
new Function(hook) // Validate the generated fixture before opening a live test session.
await writeFile(join(root,'hook.cjs'),hook)
const handler={type:'command',command:process.execPath,args:['${CLAUDE_PROJECT_DIR}/hook.cjs'],timeout:15}
await writeFile(join(config,'settings.json'),JSON.stringify({hooks:{PreToolUse:[{matcher:'Skill|Read',hooks:[handler]}],PostToolUse:[{matcher:'Skill|Read',hooks:[handler]}]}}))
await writeFile(join(skill,'SKILL.md'),'---\nname: pac-proof\ndescription: Read the proof resource when explicitly requested\nmetadata:\n  audience: test\n  workflow: verification\n---\nRead proof-resource.txt from this skill base directory and report its exact contents.\n')
await writeFile(join(skill,'proof-resource.txt'),'PAC_CONTEXT_SKILL_RESOURCE_74193')
const profile=process.env.PAC_TEST_HAPI_HOME || join(home,'.hapi-servermall'), model=process.env.PAC_TEST_MODEL || 'PAC_testpac/sonnet',json=async f=>JSON.parse((await readFile(join(profile,f),'utf8')).replace(/^\uFEFF/,'')),settings=await json('settings.json'),connection=await json('connection.json'),base=`http://127.0.0.1:${connection.relayPort}`
const waitMs=Number(process.env.PAC_TEST_TIMEOUT_MS || 180000)
if(!Number.isSafeInteger(waitMs)||waitMs<1000||waitMs>900000)throw Error('Invalid capability test timeout')
let jwt,id,archiveAttempted=false,archived=false
async function request(path,method='GET',data){const r=await fetch(base+path,{method,headers:{...(jwt?{authorization:`Bearer ${jwt}`}:{ } ),...(data?{'content-type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(150000)});if(!r.ok)throw Object.assign(new Error(`HAPI ${method} returned ${r.status}`),{status:r.status});return r.status===204?{}:r.json()}
async function until(fn,ms=waitMs){let end=Date.now()+ms;while(Date.now()<end){const r=await fn();if(r)return r;await new Promise(ok=>setTimeout(ok,1000))}throw Error('Timed out waiting for capability proof')}
async function messages(){return (await request(`/api/sessions/${id}/messages?limit=100`)).messages||[]}
async function send(text){const data={text,localId:randomUUID()},end=Date.now()+60000;while(true){try{return await request(`/api/sessions/${id}/messages`,'POST',data)}catch(e){if(e.status!==409||Date.now()>end)throw e;await new Promise(ok=>setTimeout(ok,1000))}}}
async function turn(text, marker){const old=new Set((await messages()).map(m=>m.id));let firstErrorAt;await send(text);await until(async()=>{const recent=(await messages()).filter(m=>!old.has(m.id)&&m.content?.role==='agent');const errors=recent.filter(m=>m.content?.content?.data?.type==='error');if(errors.length){const detail=JSON.stringify(errors.map(m=>m.content.content.data));if(/oauth session expired|failed to authenticate|authentication required|pac authentication failed/i.test(detail))throw Error('PAC controller authentication failed or expired; sign in again and rerun the test');firstErrorAt??=Date.now();if(Date.now()-firstErrorAt>=3000)throw Error('HAPI reported an error during the test turn; inspect the archived test session for details')}return recent.some(m=>m.content?.content?.data?.type==='message'&&(m.content.content.data.message||'').includes(marker))});const recent=(await messages()).filter(m=>!old.has(m.id)&&m.content?.role==='agent');return JSON.stringify(recent)}
async function countHooks(){try{return (await readFile(join(root,'hook-events.log'),'utf8')).trim().split(/\r?\n/).filter(Boolean).length}catch{return 0}}
try{
 jwt=(await request('/api/auth','POST',{accessToken:settings.cliApiToken})).token
 const machine=(await request('/api/machines')).machines.find(x=>x.active&&x.id===settings.machineId);if(!machine)throw Error('Existing runner unavailable')
 const models=await request(`/api/machines/${machine.id}/opencode-models?cwd=${encodeURIComponent(root)}`);if(!JSON.stringify(models).includes(model))throw Error('PAC model unavailable')
 const created=await request(`/api/machines/${machine.id}/spawn`,'POST',{directory:root,agent:'opencode',model,yolo:true,startingMode:'remote'});if(created.type!=='success'||!created.sessionId)throw Error('Could not create test session');id=created.sessionId
 const before=await turn('Use the pac-proof skill, read its resource, state its exact contents, and remember PAC_CONTEXT_MEMORY_23974. Do not modify files.','PAC_CONTEXT_SKILL_RESOURCE_74193')
 const hooksBefore=await countHooks(), skillBefore=before.includes('pac-proof')&&before.includes('[PAC tool event]');if(!skillBefore||hooksBefore<2)throw Error('Initial skill or hooks were not observed')
 console.log(JSON.stringify({stage:'before_compaction',skill:skillBefore,hookEvents:hooksBefore}))
 const prior=new Set((await messages()).map(m=>m.id));await send('/compact');await until(async()=> (await messages()).some(m=>!prior.has(m.id)&&m.content?.content?.data?.type==='compact-summary'))
 const after=await turn('Use the pac-proof skill again, read its resource and state its exact contents, then repeat the remembered PAC_CONTEXT_MEMORY marker. Do not modify files.','PAC_CONTEXT_MEMORY_23974')
 const hooksAfter=await countHooks(), skillAfter=after.includes('pac-proof')&&after.includes('[PAC tool event]')&&after.includes('PAC_CONTEXT_SKILL_RESOURCE_74193');if(!skillAfter||hooksAfter<=hooksBefore)throw Error('Skill or hooks were not observed after compaction')
 console.log(JSON.stringify({stage:'after_compaction',skill:skillAfter,hookEvents:hooksAfter,recall:true}))
 archiveAttempted=true;await request(`/api/sessions/${id}/archive`,'POST');archived=true
 const state=await request(`/api/sessions/${id}`);if(state.session?.metadata?.lifecycleState!=='archived')throw Error('Archive state was not confirmed')
 const resumed=await request(`/api/sessions/${id}/resume`,'POST',{});if(resumed.type!=='success'||resumed.sessionId!==id)throw Error('Resume did not preserve the original test session identity')
 archived=false;archiveAttempted=false
 const resumedOutput=await turn('Use the pac-proof skill, read its resource, then repeat the remembered PAC_CONTEXT_MEMORY marker. Do not modify files.','PAC_CONTEXT_MEMORY_23974')
 const hooksResumed=await countHooks(), skillResumed=resumedOutput.includes('pac-proof')&&resumedOutput.includes('[PAC tool event]')&&resumedOutput.includes('PAC_CONTEXT_SKILL_RESOURCE_74193');if(!skillResumed||hooksResumed<=hooksAfter)throw Error('Skill or hooks were not observed after resume')
 console.log(JSON.stringify({stage:'after_resume',sameSession:true,skill:skillResumed,hookEvents:hooksResumed,recall:true}))
}finally{if(id&&jwt&&!archived&&!archiveAttempted){try{await request(`/api/sessions/${id}/archive`,'POST')}catch{let confirmed=false;try{confirmed=(await request(`/api/sessions/${id}`)).session?.metadata?.lifecycleState==='archived'}catch{}if(!confirmed){console.error('Test session cleanup outcome is uncertain');process.exitCode=1}}}}
