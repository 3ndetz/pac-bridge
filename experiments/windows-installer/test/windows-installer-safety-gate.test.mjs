import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');

test('direct provider activation refuses before touching the profile', {skip:process.platform!=='win32',timeout:30000}, () => {
  const work=mkdtempSync(join(tmpdir(),'pac-installer-gate-'));
  const kit=join(work,'kit'),user=join(work,'user');
  const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'windows','Install-ProviderMode.ps1'),'-KitPath',kit,'-Activate'],{env:{...process.env,USERPROFILE:user,PSModuleAnalysisCachePath:join(work,'module-cache')},encoding:'utf8'});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/crash-safe recovery is not yet established/);
  assert.equal(existsSync(kit),false); assert.equal(existsSync(join(user,'.hapi-servermall')),false);
});

test('legacy binary installers refuse before touching the profile', {skip:process.platform!=='win32',timeout:30000}, () => {
  const work=mkdtempSync(join(tmpdir(),'pac-installer-legacy-gate-'));
  const kit=join(work,'kit'),user=join(work,'user'),unused=join(work,'unused');
  for(const script of ['Install-ExistingProfile.ps1','Install-PacRunner.ps1','Install-FromRepo.ps1']) {
    const args=['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'windows',script),'-KitPath',kit,'-KeysPath',unused,'-OpenCodePath',unused,'-HapiBinaryPath',unused];
    const result=spawnSync('powershell.exe',args,{env:{...process.env,USERPROFILE:user,PSModuleAnalysisCachePath:join(work,'module-cache')},encoding:'utf8'});
    assert.notEqual(result.status,0); assert.match(result.stderr,/Legacy HAPI binary installation is disabled/);
    assert.equal(existsSync(kit),false); assert.equal(existsSync(join(user,'.hapi-servermall')),false);
  }
});
