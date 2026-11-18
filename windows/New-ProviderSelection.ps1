function New-ProviderSelection {
  param([Parameter(Mandatory=$true)][string]$Revision, [bool]$NamedProviders, [bool]$LegacyMigration, $Previous)
  if($Revision -cnotmatch '^[0-9a-f]{40}$' -or ($LegacyMigration -and !$NamedProviders)){throw 'Invalid provider selection'}
  $selection=@{revision=$Revision;namedProviders=$NamedProviders;legacyMigration=$LegacyMigration}
  $hasRelay=if($Previous -is [Collections.IDictionary]){$Previous.Contains('relayUrl')}else{$null -ne $Previous -and $null -ne $Previous.PSObject.Properties['relayUrl']}
  if($hasRelay){
    . (Join-Path $PSScriptRoot 'Resolve-ProviderRelayUrl.ps1')
    $selection.relayUrl=Resolve-ProviderRelayUrl -Value $Previous.relayUrl
  }
  return $selection
}
