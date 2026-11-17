import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,realpath,rm,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,relative,isAbsolute,sep} from 'node:path'
import test from 'node:test'
import {readOpenCodeInstructions} from '../src/opencode-instructions.mjs'

async function fixture(run) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'pac-opencode-rules-')))
  const home=join(root,'home'),workspace=join(root,'repo')
  await mkdir(home);await mkdir(workspace);await mkdir(join(workspace,'.git'))
  const options={root:workspace,home,env:{}}
  try {await run({root,home,workspace,options})}
  finally {const local=relative(await realpath(tmpdir()),root);if(!local||isAbsolute(local)||local==='..'||local.startsWith('..'+sep)||!local.startsWith('pac-opencode-rules-'))throw new Error('Unexpected fixture root');await rm(root,{recursive:true,force:true,maxRetries:5})}
}

test('OpenCode instructions ignore local Claude files and preserve literal references',async()=>fixture(async({home,workspace,options})=>{
  await mkdir(join(home,'.claude'),{recursive:true});await mkdir(join(workspace,'.claude','rules'),{recursive:true})
  for(const path of [join(home,'.claude','CLAUDE.md'),join(workspace,'CLAUDE.md'),join(workspace,'CLAUDE.local.md'),join(workspace,'.claude','CLAUDE.md'),join(workspace,'.claude','rules','private.md')])await writeFile(path,'PRIVATE_CLAUDE_CANARY')
  assert.deepEqual(await readOpenCodeInstructions(options),[])
  await writeFile(join(workspace,'AGENTS.md'),'OpenCode rules with @missing.md as literal text')
  assert.deepEqual((await readOpenCodeInstructions(options)).map(x=>x.content),['OpenCode rules with @missing.md as literal text'])
}))

test('OpenCode uses project AGENTS and global XDG AGENTS independently',async()=>fixture(async({root,home,workspace,options})=>{
  const xdg=join(root,'xdg'),config=join(xdg,'opencode');await mkdir(config,{recursive:true})
  await writeFile(join(config,'AGENTS.md'),'Global OpenCode')
  await mkdir(join(home,'.config','opencode'),{recursive:true});await writeFile(join(home,'.config','opencode','AGENTS.md'),'Wrong global root')
  await writeFile(join(workspace,'AGENTS.md'),'Project OpenCode')
  assert.deepEqual((await readOpenCodeInstructions({...options,env:{XDG_CONFIG_HOME:xdg}})).map(x=>x.content),['Project OpenCode','Global OpenCode'])
  assert.deepEqual((await readOpenCodeInstructions({...options,env:{XDG_CONFIG_HOME:xdg,OPENCODE_DISABLE_PROJECT_CONFIG:'true'}})).map(x=>x.content),['Global OpenCode'])
  await assert.rejects(readOpenCodeInstructions({...options,env:{XDG_CONFIG_HOME:'relative'}}),/Relative/)
}))

test('OpenCode selects AGENTS before legacy CONTEXT inside its Git boundary',async()=>fixture(async({root,workspace,options})=>{
  const nested=join(workspace,'nested');await mkdir(nested)
  await writeFile(join(root,'AGENTS.md'),'Outside repository')
  await writeFile(join(workspace,'AGENTS.md'),'Repository rules')
  await writeFile(join(nested,'CONTEXT.md'),'Legacy rules')
  assert.deepEqual((await readOpenCodeInstructions({...options,root:nested})).map(x=>x.content),['Repository rules'])
  await writeFile(join(nested,'AGENTS.md'),'Nearest rules')
  assert.deepEqual((await readOpenCodeInstructions({...options,root:nested})).map(x=>x.content),['Nearest rules'])
}))

test('OpenCode nested rules stay inside the source workspace and exclude Claude rules',async()=>fixture(async({root,workspace,options})=>{
  const nested=join(workspace,'nested'),leaf=join(nested,'leaf');await mkdir(leaf,{recursive:true})
  const target=join(leaf,'source.txt');await writeFile(target,'Source file')
  await writeFile(join(workspace,'AGENTS.md'),'Already supplied root')
  await writeFile(join(nested,'AGENTS.md'),'Nested rules');await writeFile(join(leaf,'AGENTS.md'),'Leaf rules')
  await writeFile(join(leaf,'CLAUDE.md'),'PRIVATE_CLAUDE_CANARY')
  assert.deepEqual((await readOpenCodeInstructions({...options,nestedOnly:true,nestedTarget:target})).map(x=>x.content),['Leaf rules','Nested rules'])
  const outside=join(root,'outside.txt');await writeFile(outside,'Outside')
  await assert.rejects(readOpenCodeInstructions({...options,nestedOnly:true,nestedTarget:outside}),/outside/)
}))

test('OpenCode instructions enforce bounded UTF-8 reads',async()=>fixture(async({workspace,options})=>{
  const path=join(workspace,'AGENTS.md');await writeFile(path,'Too long')
  await assert.rejects(readOpenCodeInstructions({...options,maxFileBytes:3}),/size limit/)
  await assert.rejects(readOpenCodeInstructions({...options,maxTotalBytes:3}),/size limit/)
  await writeFile(path,Buffer.from([0xff]))
  await assert.rejects(readOpenCodeInstructions(options))
}))

test('OpenCode rejects linked instruction files',{skip:process.platform==='win32'},async()=>fixture(async({root,workspace,options})=>{
  const outside=join(root,'private.txt');await writeFile(outside,'Private fixture')
  await symlink(outside,join(workspace,'AGENTS.md'))
  await assert.rejects(readOpenCodeInstructions(options),/unlinked/)
}))
