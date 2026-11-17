function New-ProviderSelection {
  param([Parameter(Mandatory=$true)][string]$Revision, [bool]$NamedProviders, [bool]$LegacyMigration, $Previous)
  if($Revision -cnotmatch '^[0-9a-f]{40}$' -or ($LegacyMigration -and !$NamedProviders)){throw 'Invalid provider selection'}
  $selection=@{revision=$Revision;namedProviders=$NamedProviders;legacyMigration=$LegacyMigration}
  $hasRelay=if($Previous -is [Collections.IDictionary]){$Previous.Contains('relayUrl')}else{$null -ne $Previous -and $null -ne $Previous.PSObject.Properties['relayUrl']}
  if($hasRelay){
    if($Previous.relayUrl -isnot [string]){throw 'Invalid PAC deployment relay URL'}
    $uri=$null
    if(![Uri]::TryCreate($Previous.relayUrl,[UriKind]::Absolute,[ref]$uri) -or $uri.Scheme -ne 'wss' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/'){throw 'Invalid PAC deployment relay URL'}
    $selection.relayUrl=$uri.AbsoluteUri
  }
  return $selection
}
