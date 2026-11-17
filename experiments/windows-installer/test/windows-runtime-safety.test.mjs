import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const windows=process.platform==='win32';

test('runtime update refuses to write until crash-safe recovery is implemented', {skip:!windows,timeout:30000}, () => {
  const work=mkdtempSync(join(tmpdir(),'pac-runtime-crash-'));
  const file=join(work,'Runtime.ps1'),helper=join(root,'windows','Runtime-Lock.ps1');
  const initial='O'.repeat(200000); writeFileSync(file,initial);
  const env={...process.env,PAC_TEST_RUNTIME:file,PAC_TEST_HELPER:helper};
  const command="$ErrorActionPreference='Stop'; . $env:PAC_TEST_HELPER; Set-PacLockedBytes $env:PAC_TEST_RUNTIME ([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(('O'*200000)))) ([Text.Encoding]::UTF8.GetBytes(('N'*100000)))";
  const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command',command],{env,encoding:'utf8'});
  assert.notEqual(result.status,0);
  assert.equal(readFileSync(file,'utf8'),initial);
});

test('runtime through a parent junction is rejected', {skip:!windows,timeout:30000}, () => {
  const work=mkdtempSync(join(tmpdir(),'pac-runtime-reparse-'));
  const target=join(work,'target'),link=join(work,'link'); mkdirSync(target);
  writeFileSync(join(target,'Runtime.ps1'),'original'); symlinkSync(target,link,'junction');
  const env={...process.env,PAC_TEST_RUNTIME:join(link,'Runtime.ps1'),PAC_TEST_HELPER:join(root,'windows','Runtime-Lock.ps1')};
  const command="$ErrorActionPreference='Stop'; . $env:PAC_TEST_HELPER; Read-PacLockedBytes $env:PAC_TEST_RUNTIME | Out-Null";
  const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command',command],{env,encoding:'utf8'});
  assert.notEqual(result.status,0);
  assert.equal(readFileSync(join(target,'Runtime.ps1'),'utf8'),'original');
});

test('a junction introduced just before runtime open is rejected', {skip:!windows,timeout:30000}, async () => {
  const work=mkdtempSync(join(tmpdir(),'pac-runtime-open-race-'));
  const target=join(work,'target'),link=join(work,'link'),helper=join(work,'Runtime-Lock.ps1'); mkdirSync(target);
  writeFileSync(join(target,'Runtime.ps1'),'original');
  const source=readFileSync(join(root,'windows','Runtime-Lock.ps1'),'utf8');
  const boundary='$stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)'; assert.ok(source.includes(boundary));
  writeFileSync(helper,source.replace(boundary,'[Console]::WriteLine("WAITING"); [Console]::Out.Flush(); $null=[Console]::ReadLine(); '+boundary));
  const env={...process.env,PAC_TEST_RUNTIME:join(link,'Runtime.ps1'),PAC_TEST_HELPER:helper};
  const command="$ErrorActionPreference='Stop'; . $env:PAC_TEST_HELPER; Read-PacLockedBytes $env:PAC_TEST_RUNTIME | Out-Null";
  const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command',command],{env,stdio:['pipe','pipe','pipe']});
  const finished=once(child,'exit');
  try {
    const [chunk]=await once(child.stdout,'data'); assert.match(String(chunk),/WAITING/);
    symlinkSync(target,link,'junction');
  } finally {child.stdin.end('\n');}
  const [status]=await finished; assert.notEqual(status,0);
  assert.equal(readFileSync(join(target,'Runtime.ps1'),'utf8'),'original');
});

test('an opened runtime blocks substitution of its parent directory', {skip:!windows,timeout:30000}, async () => {
  const work=mkdtempSync(join(tmpdir(),'pac-runtime-parent-race-'));
  const dir=join(work,'profile'),moved=join(work,'profile-old'),helper=join(work,'Runtime-Lock.ps1'); mkdirSync(dir);
  const file=join(dir,'Runtime.ps1'); writeFileSync(file,'original');
  const source=readFileSync(join(root,'windows','Runtime-Lock.ps1'),'utf8');
  const boundary='Assert-PacHandlePath $stream $Path'; assert.ok(source.includes(boundary));
  writeFileSync(helper,source.replace(boundary,'[Console]::WriteLine("OPENED"); [Console]::Out.Flush(); $null=[Console]::ReadLine(); '+boundary));
  const env={...process.env,PAC_TEST_RUNTIME:file,PAC_TEST_HELPER:helper};
  const command="$ErrorActionPreference='Stop'; . $env:PAC_TEST_HELPER; Read-PacLockedBytes $env:PAC_TEST_RUNTIME | Out-Null";
  const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command',command],{env,stdio:['pipe','pipe','pipe']});
  try {
    const [chunk]=await once(child.stdout,'data'); assert.match(String(chunk),/OPENED/);
    assert.throws(()=>renameSync(dir,moved));
  } finally {child.stdin.end('\n'); await once(child,'exit');}
  assert.equal(readFileSync(file,'utf8'),'original');
});

test('exclusive parent-directory handle prevents a hard link elsewhere', {skip:!windows,timeout:30000}, async () => {
  const work=mkdtempSync(join(tmpdir(),'pac-directory-lock-'));
  const dir=join(work,'profile'),other=join(work,'other'); mkdirSync(dir); mkdirSync(other);
  const file=join(dir,'Runtime.ps1'); writeFileSync(file,'original');
  const native=String.raw`using System; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles;
public static class DirectoryLock { [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern SafeFileHandle CreateFile(string p,uint a,uint s,IntPtr d,uint m,uint f,IntPtr t); }`;
  const script=`$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${native}\n'@\n$h=[DirectoryLock]::CreateFile($env:PAC_TEST_DIR,0x80,0,[IntPtr]::Zero,3,0x02200000,[IntPtr]::Zero);if($h.IsInvalid){throw 'Directory open failed'}; [Console]::WriteLine('OPENED');[Console]::Out.Flush();$null=[Console]::ReadLine();$h.Dispose()`;
  const child=spawn('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env:{...process.env,PAC_TEST_DIR:dir},stdio:['pipe','pipe','pipe']});
  const exited=once(child,'exit');
  try {
    const observed=await Promise.race([once(child.stdout,'data').then(([chunk])=>String(chunk)),exited.then(()=>{throw new Error('Directory could not be opened');})]);
    assert.match(observed,/OPENED/); assert.throws(()=>linkSync(file,join(other,'alias.ps1')));
  } finally {child.stdin.end('\n');}
  await exited;
});
