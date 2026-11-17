import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const bash=join(process.env.LOCALAPPDATA||'','Programs','Git','bin','bash.exe');

test('POSIX install lock survives forced process termination and blocks retry', {skip:process.platform!=='win32',timeout:60000}, async () => {
  const work=mkdtempSync(join(tmpdir(),'pac-posix-lock-'));
  const repo=join(work,'repo'),scripts=join(repo,'scripts'),home=join(work,'home'),keys=join(work,'keys'),binary=join(work,'opencode.sh');
  for(const dir of [scripts,home,keys]) mkdirSync(dir,{recursive:true});
  for(const file of ['connection.json','pac-source-token.txt','pac-relay-ca.pem']) writeFileSync(join(keys,file),'synthetic');
  writeFileSync(binary,'#!/bin/sh\nexit 0\n'); chmodSync(binary,0o755);
  const source=readFileSync(join(root,'scripts','install-posix.sh'),'utf8');
  const marker="if ! mkdir \"$base/.install-lock\" 2>/dev/null; then printf '%s\\n' 'Another installation is in progress.' >&2; exit 1; fi";
  assert.ok(source.includes(marker));
  const installer=join(scripts,'install-posix.sh');
  writeFileSync(installer,source.replace(marker,marker+"\nprintf '%s\\n' LOCK_READY\nread ignored\n"));
  for(const args of [['init'],['add','.'],['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','synthetic']]) {
    assert.equal(spawnSync('git',args,{cwd:repo,encoding:'utf8'}).status,0);
  }
  const env={...process.env,PAC_TEST_HOME:home,PAC_TEST_SCRIPT:installer,PAC_TEST_KEYS:keys,PAC_TEST_BIN:binary};
  const command='export HOME="$(cygpath -u "$PAC_TEST_HOME")"; exec bash "$(cygpath -u "$PAC_TEST_SCRIPT")" "$(cygpath -u "$PAC_TEST_KEYS")" "$(cygpath -u "$PAC_TEST_BIN")"';
  const child=spawn(bash,['-c',command],{env,stdio:['pipe','pipe','pipe']});
  const exited=once(child,'exit');
  const observed=await Promise.race([once(child.stdout,'data').then(([chunk])=>String(chunk)),exited.then(()=>{throw new Error('Installer exited before acquiring its lock');})]);
  assert.match(observed,/LOCK_READY/); child.kill('SIGKILL'); await exited;
  const retry=spawnSync(bash,['-c',command],{env,encoding:'utf8',timeout:20000});
  assert.notEqual(retry.status,0); assert.match(retry.stderr,/Another installation is in progress/);
});

test('POSIX fixed temporary pointer can overwrite another file through a hard link', {skip:process.platform!=='win32',timeout:60000}, () => {
  const work=mkdtempSync(join(tmpdir(),'pac-posix-pointer-'));
  const repo=join(work,'repo'),scripts=join(repo,'scripts'),home=join(work,'home'),keys=join(work,'keys'),binary=join(work,'opencode.sh');
  for(const dir of [scripts,home,keys]) mkdirSync(dir,{recursive:true});
  for(const file of ['connection.json','pac-source-token.txt','pac-relay-ca.pem']) writeFileSync(join(keys,file),'synthetic');
  writeFileSync(binary,'#!/bin/sh\nexit 0\n'); chmodSync(binary,0o755);
  const installer=join(scripts,'install-posix.sh'); writeFileSync(installer,readFileSync(join(root,'scripts','install-posix.sh')));
  for(const args of [['init'],['add','.'],['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','synthetic']]) {
    assert.equal(spawnSync('git',args,{cwd:repo,encoding:'utf8'}).status,0);
  }
  const revision=spawnSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).stdout.trim(); assert.match(revision,/^[0-9a-f]{40}$/);
  const base=join(home,'.local','share','pac-bridge'),version=join(base,'versions',revision);
  for(const dir of [join(version,'adapters'),join(version,'scripts'),join(base,'bin')]) mkdirSync(dir,{recursive:true});
  for(const file of [join(base,'.pac-bridge-install'),join(version,'.complete'),join(version,'adapters','pac-hapi-opencode.mjs'),join(version,'scripts','pac-posix-launcher.mjs')]) writeFileSync(file,'synthetic');
  const sentinel=join(work,'independent.txt'); writeFileSync(sentinel,'preserve'); linkSync(sentinel,join(base,'current.tmp'));
  const env={...process.env,PAC_TEST_HOME:home,PAC_TEST_SCRIPT:installer,PAC_TEST_KEYS:keys,PAC_TEST_BIN:binary};
  const command='export HOME="$(cygpath -u "$PAC_TEST_HOME")"; exec bash "$(cygpath -u "$PAC_TEST_SCRIPT")" "$(cygpath -u "$PAC_TEST_KEYS")" "$(cygpath -u "$PAC_TEST_BIN")"';
  const result=spawnSync(bash,['-c',command],{env,encoding:'utf8',timeout:30000});
  assert.equal(result.status,0); assert.notEqual(readFileSync(sentinel,'utf8'),'preserve');
});
