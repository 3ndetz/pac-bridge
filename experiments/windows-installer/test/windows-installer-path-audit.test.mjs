import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');

test('provider disable can overwrite a concurrent runtime edit', {skip:process.platform!=='win32',timeout:30000}, async () => {
  const work=mkdtempSync(join(process.env.USERPROFILE,'AppData','Local','Temp','pac-disable-race-'));
  const kit=join(work,'kit'),user=join(work,'user'),pac=join(user,'.hapi-servermall','pac-bridge');
  mkdirSync(join(kit,'windows'),{recursive:true}); mkdirSync(pac,{recursive:true});
  const runtime=join(kit,'windows','Runtime.ps1'),script=join(work,'disable.ps1');
  const original="synthetic original\r\n# PAC Bridge provider loader v1\r\n. (Join-Path $env:USERPROFILE '.hapi-servermall\\pac-bridge\\provider-runtime.ps1')\r\n";
  writeFileSync(runtime,original);
  const source=readFileSync(join(root,'windows','Disable-ProviderMode.ps1'),'utf8');
  const marker='Move-Item -LiteralPath $temporary -Destination $runtime -Force'; assert.ok(source.includes(marker));
  writeFileSync(script,source.replaceAll(marker,'[Console]::WriteLine("READY"); [Console]::Out.Flush(); $null=[Console]::ReadLine(); '+marker));
  const env={...process.env,USERPROFILE:user,PSModuleAnalysisCachePath:join(work,'module-cache')};
  const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-KitPath',kit],{env,stdio:['pipe','pipe','pipe']});
  const exited=once(child,'exit');
  try {
    const signal=await Promise.race([once(child.stdout,'data').then(([chunk])=>String(chunk)),exited.then(()=>{throw new Error('Disable exited before the replacement boundary');})]);
    assert.match(signal,/READY/); writeFileSync(runtime,'independent change');
  } finally {child.stdin.end('\n');}
  const [status]=await exited; assert.equal(status,0,'Replacement failed in the synthetic fixture');
  assert.notEqual(readFileSync(runtime,'utf8'),'independent change');
});

test('notification setup can overwrite an unrelated file through its fixed temporary name', {skip:process.platform!=='win32',timeout:30000}, () => {
  const work=mkdtempSync(join(process.env.USERPROFILE,'AppData','Local','Temp','pac-notify-race-'));
  const user=join(work,'user'),pac=join(user,'.hapi-servermall','pac-bridge');
  const scripts=join(pac,'source','scripts'),bin=join(pac,'bin'); mkdirSync(scripts,{recursive:true}); mkdirSync(bin,{recursive:true});
  const wrapper=join(bin,'opencode.cmd'),config=join(work,'config.env'),sentinel=join(work,'independent.txt');
  writeFileSync(join(scripts,'telegram-notify.cjs'),'synthetic'); writeFileSync(wrapper,'@echo off\r\nexit /b 0\r\n');
  writeFileSync(config,'synthetic'); writeFileSync(sentinel,'preserve'); linkSync(sentinel,wrapper+'.new');
  const env={...process.env,USERPROFILE:user,PSModuleAnalysisCachePath:join(work,'module-cache')};
  const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'windows','Enable-TelegramNotify.ps1'),'-TelegramConfigPath',config],{env,encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,'Notification setup failed in the synthetic fixture');
  assert.notEqual(readFileSync(sentinel,'utf8'),'preserve');
});

test('Codex notification setup follows a junction outside the PAC profile', {skip:process.platform!=='win32',timeout:30000}, () => {
  const work=mkdtempSync(join(process.env.USERPROFILE,'AppData','Local','Temp','pac-notify-junction-'));
  const user=join(work,'user'),pac=join(user,'.hapi-servermall','pac-bridge'),outside=join(work,'outside'),module=join(work,'sender.cjs');
  mkdirSync(pac,{recursive:true}); mkdirSync(outside); writeFileSync(module,'synthetic');
  writeFileSync(join(pac,'provider-current.json'),'{}'); symlinkSync(outside,join(pac,'notify'),'junction');
  const env={...process.env,USERPROFILE:user,PSModuleAnalysisCachePath:join(work,'module-cache')};
  const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'windows','Use-CodexTelegramNotify.ps1'),'-SenderModulePath',module],{env,encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,'Notification setup failed in the synthetic fixture');
  assert.equal(existsSync(join(outside,'codex-telegram-module.txt')),true);
});

test('base provider activation overwrites an existing loader and fixed pointer temporary name', {skip:process.platform!=='win32',timeout:60000}, () => {
  const work=mkdtempSync(join(process.env.USERPROFILE,'AppData','Local','Temp','pac-provider-pointer-'));
  const repo=join(work,'repo'),user=join(work,'user'),profile=join(user,'.hapi-servermall'),pac=join(profile,'pac-bridge'),kit=join(work,'kit');
  for(const dir of [join(repo,'windows'),join(repo,'adapters'),join(repo,'src'),join(repo,'source-package'),pac,join(kit,'windows')]) mkdirSync(dir,{recursive:true});
  const base=spawnSync('git',['show','origin/main:windows/Install-ProviderMode.ps1'],{cwd:root,encoding:'utf8'}); assert.equal(base.status,0);
  const installer=join(repo,'windows','Install-ProviderMode.ps1'); writeFileSync(installer,base.stdout);
  for(const file of [join(repo,'adapters','fixture.mjs'),join(repo,'src','fixture.mjs'),join(repo,'source-package','package.json'),join(repo,'source-package','package-lock.json')]) writeFileSync(file,'synthetic');
  for(const args of [['init'],['add','.'],['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','synthetic']]) assert.equal(spawnSync('git',args,{cwd:repo,encoding:'utf8'}).status,0);
  const revision=spawnSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).stdout.trim(); assert.match(revision,/^[0-9a-f]{40}$/);
  const version=join(pac,'provider-versions',revision,'bin'); mkdirSync(version,{recursive:true}); writeFileSync(join(version,'opencode.cmd'),'synthetic');
  for(const file of [join(profile,'settings.json'),join(profile,'connection.json'),join(pac,'connection.json'),join(pac,'opencode-path.txt'),join(pac,'pac-source-token.txt'),join(pac,'pac-relay-ca.pem')]) writeFileSync(file,'synthetic');
  writeFileSync(join(kit,'windows','Runtime.ps1'),"# PAC Bridge provider loader v1\r\n. (Join-Path $env:USERPROFILE '.hapi-servermall\\pac-bridge\\provider-runtime.ps1')\r\n");
  const loader=join(pac,'provider-runtime.ps1'); writeFileSync(loader,'independent loader');
  const sentinel=join(work,'independent.txt'); writeFileSync(sentinel,'preserve'); linkSync(sentinel,join(pac,'provider-current.json.new'));
  const env={...process.env,USERPROFILE:user,PSModuleAnalysisCachePath:join(work,'module-cache')};
  const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',installer,'-KitPath',kit,'-Activate'],{cwd:repo,env,encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,'Base activation failed in the synthetic fixture');
  assert.notEqual(readFileSync(sentinel,'utf8'),'preserve');
  assert.notEqual(readFileSync(loader,'utf8'),'independent loader');
});

test('live dispatch migration can overwrite a concurrent wrapper edit', {skip:process.platform!=='win32',timeout:30000}, async () => {
  const work=mkdtempSync(join(process.env.USERPROFILE,'AppData','Local','Temp','pac-dispatch-race-'));
  const user=join(work,'user'),pac=join(user,'.hapi-servermall','pac-bridge'),revision='a'.repeat(40),version=join(pac,'provider-versions',revision);
  const wrapper=join(version,'bin','opencode.cmd'),adapter=join(version,'adapters','pac-hapi-opencode.mjs'),dispatcher=join(version,'adapters','provider-dispatch.mjs');
  mkdirSync(join(version,'bin'),{recursive:true}); mkdirSync(join(version,'adapters'),{recursive:true});
  writeFileSync(adapter,'synthetic'); writeFileSync(dispatcher,'synthetic');
  writeFileSync(join(pac,'provider-current.json'),JSON.stringify({revision}));
  writeFileSync(wrapper,`@echo off\r\n"${process.execPath}" "${adapter}" %*\r\nexit /b %ERRORLEVEL%\r\n`);
  const script=join(work,'dispatch.ps1'),source=readFileSync(join(root,'windows','Enable-LiveProviderDispatch.ps1'),'utf8');
  const marker='Move-Item -LiteralPath $temp -Destination $wrapper -Force'; assert.ok(source.includes(marker));
  writeFileSync(script,source.replaceAll(marker,'[Console]::WriteLine("READY"); [Console]::Out.Flush(); $null=[Console]::ReadLine(); '+marker));
  const env={...process.env,USERPROFILE:user,PSModuleAnalysisCachePath:join(work,'module-cache')};
  const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-WrapperRevision',revision],{env,stdio:['pipe','pipe','pipe']});
  const exited=once(child,'exit');
  try {
    const signal=await Promise.race([once(child.stdout,'data').then(([chunk])=>String(chunk)),exited.then(()=>{throw new Error('Migration exited before the replacement boundary');})]);
    assert.match(signal,/READY/); writeFileSync(wrapper,'independent change');
  } finally {child.stdin.end('\n');}
  const [status]=await exited; assert.equal(status,0,'Replacement failed in the synthetic fixture');
  assert.notEqual(readFileSync(wrapper,'utf8'),'independent change');
});
