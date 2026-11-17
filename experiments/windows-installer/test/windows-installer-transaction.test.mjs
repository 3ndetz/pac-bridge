import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const windows=process.platform==='win32';
const run=(cmd,args,options={})=>spawnSync(cmd,args,{encoding:'utf8',...options});

test('Windows installer rejects a ZIP before writes and preserves failed installations', {skip:!windows,timeout:120000}, () => {
  const work=mkdtempSync(join(tmpdir(),'pac-installer-transaction-'));
  const src=join(work,'source'), profile=join(work,'user'), hapi=join(profile,'.hapi-servermall');
  const kit=join(work,'kit'), keys=join(work,'keys'), bin=join(work,'bin');
  for(const d of [join(src,'windows'),join(src,'adapters'),join(src,'src'),join(src,'source-package'),hapi,join(kit,'windows'),keys,bin]) mkdirSync(d,{recursive:true});
  for(const f of ['Configure-ExistingProvider.ps1','Install-ProviderMode.ps1','Runtime-Lock.ps1']) cpSync(join(root,'windows',f),join(src,'windows',f));
  for(const f of ['settings.json','connection.json','machine-token']) writeFileSync(join(hapi,f),'{}');
  writeFileSync(join(hapi,'unrelated-sentinel.txt'),'preserve');
  writeFileSync(join(keys,'connection.json'),JSON.stringify({relayUrl:'wss://example.invalid',pacName:'test',controllerCwd:'/test'}));
  for(const f of ['pac-source-token.txt','pac-relay-ca.pem']) writeFileSync(join(keys,f),'synthetic');
  writeFileSync(join(kit,'windows','Install-Runner.ps1'),'# synthetic');
  const runtime=join(kit,'windows','Runtime.ps1'), original=Buffer.from([0xef,0xbb,0xbf,...Buffer.from('# original\r\n')]);
  writeFileSync(runtime,original);
  writeFileSync(join(src,'adapters','fixture.mjs'),'// synthetic');
  writeFileSync(join(src,'src','fixture.mjs'),'// synthetic');
  writeFileSync(join(src,'source-package','package.json'),'{}');
  writeFileSync(join(src,'source-package','package-lock.json'),'{}');
  writeFileSync(join(bin,'npm.cmd'),'@echo off\r\nif "%PAC_TEST_MUTATE%"=="1" echo independent-change>"%PAC_TEST_RUNTIME%"\r\nexit /b 42\r\n');
  const opencode=join(bin,'opencode.cmd'); writeFileSync(opencode,'@echo off\r\necho 1.19.5\r\n');
  const env={...process.env,USERPROFILE:profile,PATH:bin+';'+process.env.PATH,PAC_TEST_RUNTIME:runtime};
  const install=()=>run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(src,'windows','Configure-ExistingProvider.ps1'),'-KitPath',kit,'-KeysPath',keys,'-OpenCodePath',opencode],{env,cwd:work});
  const first=install(); assert.notEqual(first.status,0); assert.match(first.stderr,/Git checkout of PAC Bridge is required/);
  assert.equal(existsSync(join(hapi,'pac-bridge')),false); assert.deepEqual(readFileSync(runtime),original);
  const retry=install(); assert.notEqual(retry.status,0); assert.match(retry.stderr,/Git checkout of PAC Bridge is required/);
  assert.equal(existsSync(join(hapi,'pac-bridge')),false); assert.deepEqual(readFileSync(runtime),original);
  for(const args of [['init'],['add','.'],['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','synthetic']]) {
    const result=run('git',args,{cwd:src,env}); assert.equal(result.status,0,result.stderr);
  }
  const result=install(); assert.notEqual(result.status,0); assert.match(result.stderr,/dependency installation failed/);
  assert.equal(existsSync(join(hapi,'pac-bridge')),true); assert.deepEqual(readFileSync(runtime),original);
  assert.equal(readFileSync(join(hapi,'unrelated-sentinel.txt'),'utf8'),'preserve');
  const saved=readFileSync(runtime), existing=install();
  assert.notEqual(existing.status,0); assert.match(existing.stderr,/PAC profile already exists/);
  assert.deepEqual(readFileSync(runtime),saved); assert.equal(existsSync(join(hapi,'pac-bridge')),true);
  const secondUser=join(work,'second-user'),secondHapi=join(secondUser,'.hapi-servermall'),secondKit=join(work,'second-kit');
  mkdirSync(secondHapi,{recursive:true}); mkdirSync(join(secondKit,'windows'),{recursive:true});
  for(const f of ['settings.json','connection.json','machine-token']) writeFileSync(join(secondHapi,f),'{}');
  writeFileSync(join(secondKit,'windows','Install-Runner.ps1'),'# synthetic');
  const secondEnv={...env,USERPROFILE:secondUser,PAC_TEST_MUTATE:'0'};
  const absent=run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(src,'windows','Configure-ExistingProvider.ps1'),'-KitPath',secondKit,'-KeysPath',keys,'-OpenCodePath',opencode],{env:secondEnv,cwd:work});
  assert.notEqual(absent.status,0); assert.match(absent.stderr,/dependency installation failed/);
  assert.equal(existsSync(join(secondKit,'windows','Runtime.ps1')),true);
  assert.equal(existsSync(join(secondHapi,'pac-bridge')),true);
  const thirdUser=join(work,'third-user'),thirdHapi=join(thirdUser,'.hapi-servermall'),thirdKit=join(work,'third-kit');
  mkdirSync(thirdHapi,{recursive:true}); mkdirSync(join(thirdKit,'windows'),{recursive:true});
  for(const f of ['settings.json','connection.json','machine-token']) writeFileSync(join(thirdHapi,f),'{}');
  writeFileSync(join(thirdKit,'windows','Install-Runner.ps1'),'# synthetic');
  const thirdRuntime=join(thirdKit,'windows','Runtime.ps1'); writeFileSync(thirdRuntime,original);
  const thirdEnv={...env,USERPROFILE:thirdUser,PAC_TEST_MUTATE:'1',PAC_TEST_RUNTIME:thirdRuntime};
  const changed=run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(src,'windows','Configure-ExistingProvider.ps1'),'-KitPath',thirdKit,'-KeysPath',keys,'-OpenCodePath',opencode],{env:thirdEnv,cwd:work});
  assert.notEqual(changed.status,0); assert.match(changed.stderr,/Runtime.ps1 changed unexpectedly/);
  assert.match(readFileSync(thirdRuntime,'utf8'),/independent-change/); assert.equal(existsSync(join(thirdHapi,'pac-bridge')),true);
});

test('exclusive runtime update refuses a concurrent holder', {skip:!windows,timeout:30000}, async () => {
  const work=mkdtempSync(join(tmpdir(),'pac-runtime-lock-'));
  const file=join(work,'Runtime.ps1'),replacement=join(work,'replacement.ps1'),backup=join(work,'backup.ps1');
  writeFileSync(file,'initial'); writeFileSync(replacement,'replacement');
  const env={...process.env,PAC_TEST_RUNTIME:file,PAC_TEST_REPLACEMENT:replacement,PAC_TEST_BACKUP:backup,PAC_TEST_HELPER:join(root,'windows','Runtime-Lock.ps1')};
  const hold='$s=[IO.File]::Open($env:PAC_TEST_RUNTIME,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); [Console]::WriteLine("READY"); [Console]::Out.Flush(); $null=[Console]::ReadLine(); $s.Dispose()';
  const child=spawn('powershell.exe',['-NoProfile','-Command',hold],{env,stdio:['pipe','pipe','pipe']});
  try {
    const [data]=await once(child.stdout,'data'); assert.match(String(data),/READY/);
    const update="$ErrorActionPreference='Stop'; . $env:PAC_TEST_HELPER; Set-PacLockedBytes $env:PAC_TEST_RUNTIME ([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('initial'))) ([Text.Encoding]::UTF8.GetBytes('replacement'))";
    const contender=run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command',update],{env});
    assert.notEqual(contender.status,0);
    const replace="$ErrorActionPreference='Stop'; [IO.File]::Replace($env:PAC_TEST_REPLACEMENT,$env:PAC_TEST_RUNTIME,$env:PAC_TEST_BACKUP)";
    const swap=run('powershell.exe',['-NoProfile','-Command',replace],{env});
    assert.notEqual(swap.status,0);
  } finally { child.stdin.end('\n'); await once(child,'exit'); }
  assert.equal(readFileSync(file,'utf8'),'initial');
});
