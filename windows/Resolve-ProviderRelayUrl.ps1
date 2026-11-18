function Resolve-ProviderRelayUrl {
  param([Parameter(Mandatory=$true)][AllowNull()][AllowEmptyString()]$Value)
  if($Value -isnot [string]){throw 'Invalid PAC deployment relay URL'}
  $uri=$null
  if(![Uri]::TryCreate($Value,[UriKind]::Absolute,[ref]$uri) -or $uri.Scheme -ne 'wss' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/'){
    throw 'Invalid PAC deployment relay URL'
  }
  return $uri.AbsoluteUri
}
