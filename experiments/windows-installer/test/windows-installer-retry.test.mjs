import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const run=(cmd,args,options={})=>spawnSync(cmd,args,{encoding:'utf8',...options});

test('a failed new profile can be safely retried', {skip:process.platform!=='win32',timeout:120000}, () => {
  const work=mkdtempSync(join(tmpdir(),'pac-installer-retry-'));
  const src=join(work,'source'), user=join(work,'user'), hapi=join(user,'.hapi-servermall');
  const kit=join(work,'kit'), keys=join(work,'keys'), bin=join(work,'bin');
  for(const d of [join(src,'windows'),join(src,'adapters'),join(src,'src'),join(src,'source-package'),hapi,join(kit,'windows'),keys,bin])mkdirSync(d,{recursive:true});
  for(const f of ['Configure-ExistingProvider.ps1','Install-ProviderMode.ps1','Runtime-Lock.ps1'])cpSync(join(root,'windows',f),join(src,'windows',f));
  for(const f of ['settings.json','connection.json','machine-token'])writeFileSync(join(hapi,f),'{}');
  writeFileSync(join(keys,'connection.json'),JSON.stringify({relayUrl:'wss://example.invalid',pacName:'test',controllerCwd:'/test'}));
  for(const f of ['pac-source-token.txt','pac-relay-ca.pem'])writeFileSync(join(keys,f),'synthetic');
  writeFileSync(join(kit,'windows','Install-Runner.ps1'),'');
  const runtime=join(kit,'windows','Runtime.ps1');writeFileSync(runtime,'original');
  writeFileSync(join(src,'adapters','install-hapi-command.mjs'),"import {mkdirSync,writeFileSync} from 'node:fs'; import {join} from 'node:path'; mkdirSync(process.argv[2],{recursive:true}); writeFileSync(join(process.argv[2],'opencode.cmd'),'@echo off');");
  writeFileSync(join(src,'src','fixture.mjs'),'');
  for(const f of ['package.json','package-lock.json'])writeFileSync(join(src,'source-package',f),'{}');
  const npm=join(bin,'npm.cmd'),opencode=join(bin,'opencode.cmd');
  writeFileSync(npm,'@echo off\r\nexit /b 42\r\n');writeFileSync(opencode,'@echo off\r\necho 1.19.5\r\n');
  const env={...process.env,USERPROFILE:user,PATH:bin+';'+process.env.PATH};
  for(const args of [['init'],['add','.'],['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','synthetic']]){
    const r=run('git',args,{cwd:src,env});assert.equal(r.status,0,r.stderr);
  }
  const install=()=>run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(src,'windows','Configure-ExistingProvider.ps1'),'-KitPath',kit,'-KeysPath',keys,'-OpenCodePath',opencode],{cwd:work,env});
  const failed=install();assert.notEqual(failed.status,0);assert.equal(readFileSync(runtime,'utf8'),'original');
  assert.equal(existsSync(join(hapi,'pac-bridge')),false,'Disabled installer must refuse before creating a profile');
  writeFileSync(npm,'@echo off\r\nexit /b 0\r\n');
  const retried=install();assert.equal(retried.status,0,'Retry must complete without deleting unrelated data: '+retried.stderr);
  assert.match(readFileSync(runtime,'utf8'),/PAC Bridge provider loader v1/);
});
