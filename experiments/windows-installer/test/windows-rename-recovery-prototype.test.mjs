import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const native=String.raw`
using System; using System.IO; using System.Security.Cryptography; using System.Runtime.InteropServices; using System.Text; using Microsoft.Win32.SafeHandles;
public static class RenamePrototype {
 [StructLayout(LayoutKind.Sequential)] struct StatusBlock { public IntPtr Status; public IntPtr Information; }
 [StructLayout(LayoutKind.Sequential)] struct FileInfo { public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created,Accessed,Written; public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string p,uint a,uint s,IntPtr d,uint m,uint f,IntPtr t);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out FileInfo info);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle h,StringBuilder path,uint length,uint flags);
 [DllImport("ntdll.dll")] static extern int NtSetInformationFile(SafeFileHandle h,out StatusBlock io,IntPtr p,uint n,int c);
 static string Identity(SafeFileHandle h) { FileInfo i; if(!GetFileInformationByHandle(h,out i)) throw new Exception("Identity failed"); if((i.Attributes & 0x400)!=0) throw new Exception("Reparse point refused"); if(i.Links!=1) throw new Exception("Multiple hard links refused"); return i.Volume.ToString("X8")+i.IndexHigh.ToString("X8")+i.IndexLow.ToString("X8"); }
 static void CheckPath(SafeFileHandle h,string expected) { var b=new StringBuilder(32768); uint n=GetFinalPathNameByHandle(h,b,(uint)b.Capacity,0); if(n==0 || n>=b.Capacity) throw new Exception("Path check failed"); string actual=b.ToString(); if(actual.StartsWith(@"\\?\UNC\",StringComparison.OrdinalIgnoreCase)) actual=@"\\"+actual.Substring(8); else if(actual.StartsWith(@"\\?\")) actual=actual.Substring(4); if(!String.Equals(Path.GetFullPath(actual),Path.GetFullPath(expected),StringComparison.OrdinalIgnoreCase)) throw new Exception("Unexpected handle path"); }
 public static SafeFileHandle OpenDirectory(string path) { var h=CreateFile(path,0x80,0,IntPtr.Zero,3,0x02200000,IntPtr.Zero); if(h.IsInvalid) throw new Exception("Directory open failed"); return h; }
 public static string Inspect(string path) { using(var h=CreateFile(path,0x80000000,0,IntPtr.Zero,3,0x00200000,IntPtr.Zero)) { if(h.IsInvalid) throw new Exception("Open failed"); CheckPath(h,path); return Identity(h); } }
 public static int RenameChecked(string path,string name,string identity) { return RenameCore(path,name,identity,null); }
 public static int RenameVerified(string path,string name,string identity,string digest) { return RenameCore(path,name,identity,digest); }
 public static int Rename(string path,string name) {
  return RenameCore(path,name,null,null);
 }
 static int RenameCore(string path,string name,string identity,string digest) {
  if(name.IndexOfAny(new char[]{'\\','/',':'})>=0 || name=="." || name=="..") throw new Exception("Invalid name");
  using(var h=CreateFile(path,0xC0010000,0,IntPtr.Zero,3,0x00200000,IntPtr.Zero)) {
   if(h.IsInvalid) throw new Exception("Exclusive open failed"); CheckPath(h,path); if(identity!=null && Identity(h)!=identity) throw new Exception("Identity changed");
   using(var stream=new FileStream(h,FileAccess.Read)) {
    if(digest!=null) { using(var sha=SHA256.Create()) { var actual=BitConverter.ToString(sha.ComputeHash(stream)).Replace("-",""); if(actual!=digest) throw new Exception("Content changed"); } }
    byte[] text=Encoding.Unicode.GetBytes(name); int size=24+text.Length; IntPtr p=Marshal.AllocHGlobal(size);
    try { for(int i=0;i<size;i++)Marshal.WriteByte(p,i,0); Marshal.WriteInt32(p,16,text.Length); Marshal.Copy(text,0,IntPtr.Add(p,20),text.Length); StatusBlock io; return NtSetInformationFile(h,out io,p,(uint)size,65); } finally {Marshal.FreeHGlobal(p);}
   }
  }
 }
}`;

test('prototype retains original after interruption and refuses to replace an occupant', {skip:process.platform!=='win32',timeout:60000}, async () => {
  const work=mkdtempSync(join(tmpdir(),'pac-rename-recovery-'));
  const original=join(work,'runtime.ps1'),backup=join(work,'saved.ps1'),journal=join(work,'identity.txt');
  writeFileSync(original,'synthetic original');
  const env={...process.env,PAC_TEST_SRC:original,PAC_TEST_JOURNAL:journal,PAC_TEST_DIGEST:createHash('sha256').update('synthetic original').digest('hex').toUpperCase()};
  const encoded=Buffer.from(`Add-Type -TypeDefinition @'\n${native}\n'@\n$id=[RenamePrototype]::Inspect($env:PAC_TEST_SRC); [IO.File]::WriteAllText($env:PAC_TEST_JOURNAL,$id); $s=[RenamePrototype]::RenameChecked($env:PAC_TEST_SRC,'saved.ps1',$id); if($s -ne 0){exit 2}; [Console]::WriteLine('RENAMED'); [Console]::Out.Flush(); [Threading.Thread]::Sleep(300000)`,'utf16le').toString('base64');
  const child=spawn('powershell.exe',['-NoProfile','-EncodedCommand',encoded],{env,stdio:['ignore','pipe','pipe']});
  const exited=once(child,'exit');
  const signal=await Promise.race([once(child.stdout,'data').then(([chunk])=>String(chunk)),exited.then(()=>{throw new Error('Prototype exited before the rename boundary');})]);
  assert.match(signal,/RENAMED/); child.kill(); await exited;
  assert.equal(existsSync(original),false); assert.equal(readFileSync(backup,'utf8'),'synthetic original');
  const recover=Buffer.from(`$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${native}\n'@\n$id=[IO.File]::ReadAllText($env:PAC_TEST_JOURNAL); if([RenamePrototype]::RenameVerified($env:PAC_TEST_SRC,'runtime.ps1',$id,$env:PAC_TEST_DIGEST) -ne 0){exit 4}`,'utf16le').toString('base64');
  const recoveryEnv={...env,PAC_TEST_SRC:backup};
  writeFileSync(original,'independent change');
  const conflict=spawnSync('powershell.exe',['-NoProfile','-EncodedCommand',recover],{env:recoveryEnv,encoding:'utf8'});
  assert.notEqual(conflict.status,0); assert.equal(readFileSync(original,'utf8'),'independent change'); assert.equal(readFileSync(backup,'utf8'),'synthetic original');
  const second=join(work,'second'); mkdirSync(second); const secondBackup=join(second,'saved.ps1');
  const moveToSecond=spawnSync('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(`$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${native}\n'@\nif([RenamePrototype]::RenameChecked($env:PAC_TEST_SRC,'second-original.ps1',[IO.File]::ReadAllText($env:PAC_TEST_JOURNAL)) -ne 0){exit 4}`,'utf16le').toString('base64')],{env:recoveryEnv,encoding:'utf8'});
  assert.equal(moveToSecond.status,0);
  const moved=join(work,'second-original.ps1');
  renameSync(moved,secondBackup);
  const recovered=spawnSync('powershell.exe',['-NoProfile','-EncodedCommand',recover],{env:{...env,PAC_TEST_SRC:secondBackup},encoding:'utf8'});
  assert.equal(recovered.status,0); assert.equal(readFileSync(join(second,'runtime.ps1'),'utf8'),'synthetic original');
});

test('prototype refuses modified content in the same file identity', {skip:process.platform!=='win32',timeout:30000}, () => {
  const work=mkdtempSync(join(tmpdir(),'pac-rename-content-'));
  const backup=join(work,'saved.ps1'),restored=join(work,'runtime.ps1');
  writeFileSync(backup,'synthetic original');
  const env={...process.env,PAC_TEST_SRC:backup,PAC_TEST_DIGEST:createHash('sha256').update('synthetic original').digest('hex').toUpperCase()};
  const script=`$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${native}\n'@\n$id=[RenamePrototype]::Inspect($env:PAC_TEST_SRC); [IO.File]::WriteAllText($env:PAC_TEST_SRC,'independent change'); [RenamePrototype]::RenameVerified($env:PAC_TEST_SRC,'runtime.ps1',$id,$env:PAC_TEST_DIGEST)`;
  const result=spawnSync('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env,encoding:'utf8'});
  assert.notEqual(result.status,0); assert.equal(existsSync(restored),false);
  assert.equal(readFileSync(backup,'utf8'),'independent change');
});

test('prototype rejects a backup reached through a parent junction', {skip:process.platform!=='win32',timeout:30000}, () => {
  const work=mkdtempSync(join(tmpdir(),'pac-rename-junction-'));
  const target=join(work,'target'),link=join(work,'link'); mkdirSync(target);
  writeFileSync(join(target,'saved.ps1'),'synthetic original'); symlinkSync(target,link,'junction');
  const env={...process.env,PAC_TEST_SRC:join(link,'saved.ps1')};
  const script=`$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${native}\n'@\n[RenamePrototype]::Inspect($env:PAC_TEST_SRC)`;
  const result=spawnSync('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env,encoding:'utf8'});
  assert.notEqual(result.status,0); assert.equal(readFileSync(join(target,'saved.ps1'),'utf8'),'synthetic original');
});

test('prototype refuses a file with another hard link', {skip:process.platform!=='win32',timeout:30000}, () => {
  const work=mkdtempSync(join(tmpdir(),'pac-rename-hardlink-'));
  const backup=join(work,'saved.ps1'),alias=join(work,'alias.ps1');
  writeFileSync(backup,'synthetic original'); linkSync(backup,alias);
  const env={...process.env,PAC_TEST_SRC:backup};
  const script=`$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${native}\n'@\n[RenamePrototype]::Inspect($env:PAC_TEST_SRC)`;
  const result=spawnSync('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env,encoding:'utf8'});
  assert.notEqual(result.status,0); assert.equal(readFileSync(backup,'utf8'),'synthetic original'); assert.equal(readFileSync(alias,'utf8'),'synthetic original');
});

test('prototype rejects a junction inserted immediately before opening a backup', {skip:process.platform!=='win32',timeout:30000}, async () => {
  const work=mkdtempSync(join(tmpdir(),'pac-rename-junction-race-'));
  const target=join(work,'target'),link=join(work,'link'); mkdirSync(target);
  const original=join(target,'saved.ps1'); writeFileSync(original,'synthetic original');
  const env={...process.env,PAC_TEST_ORIGINAL:original,PAC_TEST_SRC:join(link,'saved.ps1'),PAC_TEST_DIGEST:createHash('sha256').update('synthetic original').digest('hex').toUpperCase()};
  const marker='using(var h=CreateFile(path,0xC0010000'; assert.ok(native.includes(marker));
  const instrumented=native.replace(marker,'Console.WriteLine("WAITING"); Console.Out.Flush(); Console.ReadLine(); '+marker);
  const script=`$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${instrumented}\n'@\n$id=[RenamePrototype]::Inspect($env:PAC_TEST_ORIGINAL); [RenamePrototype]::RenameVerified($env:PAC_TEST_SRC,'runtime.ps1',$id,$env:PAC_TEST_DIGEST)`;
  const child=spawn('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env,stdio:['pipe','pipe','pipe']});
  const exited=once(child,'exit');
  try {
    const observed=await Promise.race([once(child.stdout,'data').then(([chunk])=>String(chunk)),exited.then(()=>{throw new Error('Prototype exited before the open boundary');})]);
    assert.match(observed,/WAITING/); symlinkSync(target,link,'junction');
  } finally {child.stdin.end('\n');}
  const [status]=await exited; assert.notEqual(status,0);
  assert.equal(readFileSync(original,'utf8'),'synthetic original'); assert.equal(existsSync(join(target,'runtime.ps1')),false);
});

test('prototype holds the file exclusively from verification through rename', {skip:process.platform!=='win32',timeout:30000}, async () => {
  const work=mkdtempSync(join(tmpdir(),'pac-rename-contention-'));
  const backup=join(work,'saved.ps1'),restored=join(work,'runtime.ps1');
  writeFileSync(backup,'synthetic original');
  const env={...process.env,PAC_TEST_SRC:backup,PAC_TEST_DIGEST:createHash('sha256').update('synthetic original').digest('hex').toUpperCase()};
  const marker='byte[] text=Encoding.Unicode.GetBytes(name);'; assert.ok(native.includes(marker));
  const instrumented=native.replace(marker,'Console.WriteLine("LOCKED"); Console.Out.Flush(); Console.ReadLine(); '+marker);
  const script=`$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${instrumented}\n'@\n$id=[RenamePrototype]::Inspect($env:PAC_TEST_SRC); if([RenamePrototype]::RenameVerified($env:PAC_TEST_SRC,'runtime.ps1',$id,$env:PAC_TEST_DIGEST) -ne 0){exit 4}`;
  const child=spawn('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env,stdio:['pipe','pipe','pipe']});
  const exited=once(child,'exit');
  try {
    const signal=await Promise.race([once(child.stdout,'data').then(([chunk])=>String(chunk)),exited.then(()=>{throw new Error('Prototype exited before locking');})]);
    assert.match(signal,/LOCKED/); assert.throws(()=>writeFileSync(backup,'independent change'));
    assert.throws(()=>linkSync(backup,join(work,'alias.ps1')));
  } finally { child.stdin.end('\n'); }
  const [status]=await exited; assert.equal(status,0);
  assert.equal(readFileSync(restored,'utf8'),'synthetic original');
});

test('combined exclusive file and directory handles prevent an external hard link', {skip:process.platform!=='win32',timeout:30000}, async () => {
  const work=mkdtempSync(join(tmpdir(),'pac-combined-lock-'));
  const dir=join(work,'profile'),other=join(work,'other'); mkdirSync(dir); mkdirSync(other);
  const backup=join(dir,'saved.ps1'); writeFileSync(backup,'synthetic original');
  const env={...process.env,PAC_TEST_SRC:backup,PAC_TEST_DIR:dir,PAC_TEST_DIGEST:createHash('sha256').update('synthetic original').digest('hex').toUpperCase()};
  const marker='byte[] text=Encoding.Unicode.GetBytes(name);'; assert.ok(native.includes(marker));
  const instrumented=native.replace(marker,'Console.WriteLine("LOCKED"); Console.Out.Flush(); Console.ReadLine(); '+marker);
  const script=`$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${instrumented}\n'@\n$d=[RenamePrototype]::OpenDirectory($env:PAC_TEST_DIR); $id=[RenamePrototype]::Inspect($env:PAC_TEST_SRC); if([RenamePrototype]::RenameVerified($env:PAC_TEST_SRC,'runtime.ps1',$id,$env:PAC_TEST_DIGEST) -ne 0){exit 4}; $d.Dispose()`;
  const child=spawn('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env,stdio:['pipe','pipe','pipe']});
  const exited=once(child,'exit');
  try {
    const signal=await Promise.race([once(child.stdout,'data').then(([chunk])=>String(chunk)),exited.then(()=>{throw new Error('Prototype exited before locking');})]);
    assert.match(signal,/LOCKED/); assert.throws(()=>linkSync(backup,join(other,'alias.ps1')));
  } finally {child.stdin.end('\n');}
  await exited;
});

test('prototype preserves original across selected process termination boundaries', {skip:process.platform!=='win32',timeout:120000}, async () => {
  for(const phase of ['JOURNAL_PARTIAL','JOURNAL','PARTIAL','STAGED','BACKUP','PUBLISHED']) {
    const work=mkdtempSync(join(tmpdir(),'pac-recovery-boundary-'));
    const runtime=join(work,'runtime.ps1'),backup=join(work,'saved.ps1'),stage=join(work,'stage.ps1'),journal=join(work,'identity.txt');
    writeFileSync(runtime,'synthetic original');
    const digest=(value)=>createHash('sha256').update(value).digest('hex').toUpperCase();
    const env={...process.env,PAC_TEST_SRC:runtime,PAC_TEST_BACKUP:backup,PAC_TEST_STAGE:stage,PAC_TEST_JOURNAL:journal,PAC_TEST_PHASE:phase,PAC_TEST_DIGEST:digest('synthetic original'),PAC_TEST_NEW_DIGEST:digest('synthetic replacement')};
    const script=`$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${native}\n'@\nfunction Mark($phase) { if($env:PAC_TEST_PHASE -eq $phase){[Console]::WriteLine($phase);[Console]::Out.Flush();[Threading.Thread]::Sleep(300000)} }; $id=[RenamePrototype]::Inspect($env:PAC_TEST_SRC); $bytes=[Text.Encoding]::UTF8.GetBytes($id); $j=[IO.File]::Open($env:PAC_TEST_JOURNAL,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None); $j.Write($bytes,0,5);Mark JOURNAL_PARTIAL;$j.Write($bytes,5,$bytes.Length-5);$j.Flush($true);$j.Dispose();Mark JOURNAL; $bytes=[Text.Encoding]::UTF8.GetBytes('synthetic replacement');$f=[IO.File]::Open($env:PAC_TEST_STAGE,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);$f.Write($bytes,0,5);Mark PARTIAL;$f.Write($bytes,5,$bytes.Length-5);$f.Flush($true);$f.Dispose();Mark STAGED;if([RenamePrototype]::RenameVerified($env:PAC_TEST_SRC,'saved.ps1',$id,$env:PAC_TEST_DIGEST) -ne 0){exit 4};Mark BACKUP;$newId=[RenamePrototype]::Inspect($env:PAC_TEST_STAGE);if([RenamePrototype]::RenameVerified($env:PAC_TEST_STAGE,'runtime.ps1',$newId,$env:PAC_TEST_NEW_DIGEST) -ne 0){exit 5};Mark PUBLISHED`;
    const child=spawn('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env,stdio:['ignore','pipe','pipe']});
    const exited=once(child,'exit');
    const observed=await Promise.race([once(child.stdout,'data').then(([chunk])=>String(chunk)),exited.then(()=>{throw new Error('Prototype exited before '+phase);})]);
    assert.match(observed,new RegExp(phase)); child.kill(); await exited;
    if(phase==='BACKUP') {
      assert.equal(existsSync(runtime),false);
      const recover=`$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${native}\n'@\n$id=[IO.File]::ReadAllText($env:PAC_TEST_JOURNAL);if([RenamePrototype]::RenameVerified($env:PAC_TEST_BACKUP,'runtime.ps1',$id,$env:PAC_TEST_DIGEST) -ne 0){exit 6}`;
      const delayed=recover.replace('byte[] text=Encoding.Unicode.GetBytes(name);','Console.WriteLine("RECOVERY"); Console.Out.Flush(); System.Threading.Thread.Sleep(300000); byte[] text=Encoding.Unicode.GetBytes(name);');
      const recoveryChild=spawn('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(delayed,'utf16le').toString('base64')],{env,stdio:['ignore','pipe','pipe']});
      const recoveryExit=once(recoveryChild,'exit');
      const recoverySignal=await Promise.race([once(recoveryChild.stdout,'data').then(([chunk])=>String(chunk)),recoveryExit.then(()=>{throw new Error('Recovery exited before rename');})]);
      assert.match(recoverySignal,/RECOVERY/); recoveryChild.kill(); await recoveryExit;
      assert.equal(existsSync(runtime),false); assert.equal(readFileSync(backup,'utf8'),'synthetic original');
      const result=spawnSync('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(recover,'utf16le').toString('base64')],{env,encoding:'utf8'});
      assert.equal(result.status,0); assert.equal(readFileSync(runtime,'utf8'),'synthetic original');
    } else if(phase==='PUBLISHED') {
      assert.equal(readFileSync(runtime,'utf8'),'synthetic replacement');
      assert.equal(readFileSync(backup,'utf8'),'synthetic original');
    } else {
      assert.equal(readFileSync(runtime,'utf8'),'synthetic original');
      assert.equal(existsSync(backup),false);
    }
  }
});

test('prototype refuses a different backup even with identical contents', {skip:process.platform!=='win32',timeout:30000}, () => {
  const work=mkdtempSync(join(tmpdir(),'pac-rename-identity-'));
  const original=join(work,'original.ps1'),backup=join(work,'saved.ps1'),restored=join(work,'runtime.ps1');
  writeFileSync(original,'synthetic original'); writeFileSync(backup,'synthetic original');
  const env={...process.env,PAC_TEST_SRC:original,PAC_TEST_BACKUP:backup};
  const script=`$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${native}\n'@\n$id=[RenamePrototype]::Inspect($env:PAC_TEST_SRC); [RenamePrototype]::RenameChecked($env:PAC_TEST_BACKUP,'runtime.ps1',$id)`;
  const encoded=Buffer.from(script,'utf16le').toString('base64');
  const result=spawnSync('powershell.exe',['-NoProfile','-EncodedCommand',encoded],{env,encoding:'utf8'});
  assert.notEqual(result.status,0); assert.equal(existsSync(restored),false);
  assert.equal(readFileSync(original,'utf8'),'synthetic original'); assert.equal(readFileSync(backup,'utf8'),'synthetic original');
});
