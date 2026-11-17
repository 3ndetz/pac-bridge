import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');

test('wrapper generator cannot safely retry after interruption following directory creation', {timeout:30000}, async () => {
  const work=mkdtempSync(join(tmpdir(),'pac-wrapper-retry-'));
  const script=join(work,'install.mjs'),target=join(work,'wrapper');
  const source=readFileSync(join(root,'adapters','install-hapi-command.mjs'),'utf8');
  const marker='await mkdir(directory, { mode: 0o700 })'; assert.ok(source.includes(marker));
  writeFileSync(script,source.replace(marker,marker+"\nprocess.stdout.write('READY\\n')\nawait new Promise(() => setInterval(() => {}, 10000))"));
  const child=spawn(process.execPath,[script,target],{stdio:['ignore','pipe','pipe']});
  const exited=once(child,'exit');
  const observed=await Promise.race([once(child.stdout,'data').then(([chunk])=>String(chunk)),exited.then(()=>{throw new Error('Generator exited before directory creation');})]);
  assert.match(observed,/READY/); child.kill('SIGKILL'); await exited;
  assert.equal(existsSync(target),true);
  const retry=spawnSync(process.execPath,[script,target],{encoding:'utf8',timeout:10000});
  assert.notEqual(retry.status,0); assert.match(retry.stderr,/EEXIST/);
});
