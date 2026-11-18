import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('Windows provider selection preserves the validated transport and rejects unsafe updates', {skip:process.platform !== 'win32'}, () => {
  const path = fileURLToPath(new URL('../windows/New-ProviderSelection.ps1', import.meta.url)).replaceAll("'", "''")
  const script = "$ErrorActionPreference='Stop';. '" + path + "';" + `
    $v=New-ProviderSelection -Revision ('a'*40) -NamedProviders $true -LegacyMigration $true -Previous ([pscustomobject]@{relayUrl='wss://relay.example:8792'})
    if($v.relayUrl -ne 'wss://relay.example:8792/'){throw 'Lost relay endpoint'}
    $plain=New-ProviderSelection -Revision ('b'*40) -NamedProviders $false -LegacyMigration $false
    if($plain.Contains('relayUrl')){throw 'Unexpected override'}
    $rejected=0
    foreach($url in @('ws://relay.example','wss://user:secret@relay.example','wss://relay.example/?token=x','wss://relay.example/#x','wss://relay.example/other',$null)){
      $denied=$false
      try{$null=New-ProviderSelection -Revision ('a'*40) -NamedProviders $true -Previous ([pscustomobject]@{relayUrl=$url})}catch{$denied=$true}
      if(!$denied){throw 'Unsafe relay endpoint accepted'}
      $rejected++
    }
    $denied=$false
    try{$null=New-ProviderSelection -Revision ('a'*40) -NamedProviders $false -LegacyMigration $true}catch{$denied=$true}
    if(!$denied){throw 'Invalid migration flags accepted'}
    @{preserved=$true;rejected=$rejected}|ConvertTo-Json -Compress
  `
  const result = spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:15000})
  assert.equal(result.status,0,result.stderr || result.error?.message)
  assert.deepEqual(JSON.parse(result.stdout.trim()),{preserved:true,rejected:6})
})


test('Windows connection URLs accept a TLS root with or without its trailing slash', {skip:process.platform !== 'win32'}, () => {
  const path=fileURLToPath(new URL('../windows/Resolve-ProviderRelayUrl.ps1',import.meta.url)).replaceAll("'","''")
  const script="$ErrorActionPreference='Stop';. '"+path+"';"+`
    foreach($url in @('wss://relay.example:8793','wss://relay.example:8793/')){
      if((Resolve-ProviderRelayUrl -Value $url) -cne 'wss://relay.example:8793/'){throw 'Root URL rejected'}
    }
    $count=0
    foreach($url in @('ws://relay.example','wss://user:secret@relay.example','wss://relay.example/other','wss://relay.example/?token=x','wss://relay.example/#x','',42,$null)){
      $rejected=$false;try{$null=Resolve-ProviderRelayUrl -Value $url}catch{$rejected=$true}
      if(!$rejected){throw 'Unsafe relay URL accepted'};$count++
    }
    @{accepted=2;rejected=$count}|ConvertTo-Json -Compress
  `
  const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:15000})
  assert.equal(r.status,0,r.stderr||r.error?.message);assert.deepEqual(JSON.parse(r.stdout.trim()),{accepted:2,rejected:8})
})
