function Assert-ProviderCheckout {
  param([Parameter(Mandatory=$true)][string]$Source)
  $ErrorActionPreference='Stop'
  # Validate the exact source checkout before creating or changing a profile.
  $source=(Resolve-Path -LiteralPath $Source).Path
  if(!(Get-Command git.exe -ErrorAction SilentlyContinue)){throw 'Git is required and the source must be a Git checkout.'}
  $checkoutRoot=$null
  try { $checkoutRoot=(& git.exe -C $source rev-parse --show-toplevel 2>$null) } catch { }
  if($LASTEXITCODE -ne 0 -or !$checkoutRoot){throw 'The source must be a Git checkout; ZIP snapshots are not supported.'}
  try { $resolvedCheckout=(Resolve-Path -LiteralPath $checkoutRoot).Path } catch { throw 'The source checkout could not be resolved.' }
  if(![StringComparer]::OrdinalIgnoreCase.Equals($source.TrimEnd('\','/'),$resolvedCheckout.TrimEnd('\','/'))){throw 'The source must be the root of its own Git checkout.'}
  $head=$null
  try { $head=(& git.exe -C $source rev-parse --verify HEAD 2>$null) } catch { }
  if($LASTEXITCODE -ne 0 -or !$head -or $head.Trim() -cnotmatch '^[0-9a-f]{40}$'){throw 'The source checkout requires a valid commit.'}
  & git.exe -C $source diff --quiet HEAD -- adapters src source-package
  if($LASTEXITCODE -ne 0){throw 'Commit or discard source changes before configuring a profile.'}
  try { & git.exe -C $source ls-files --error-unmatch -- source-package/package.json source-package/package-lock.json 2>$null | Out-Null } catch { throw 'The source dependency manifests must be tracked.' }
  if($LASTEXITCODE -ne 0){throw 'The source dependency manifests must be tracked.'}
  try { & git.exe -C $source ls-files --error-unmatch -- adapters/install-hapi-command.mjs adapters/pac-hapi-opencode.mjs src/opencode-provider.mjs 2>$null | Out-Null } catch { throw 'The checkout is missing tracked provider source files.' }
  if($LASTEXITCODE -ne 0){throw 'The checkout is missing tracked provider source files.'}
}
