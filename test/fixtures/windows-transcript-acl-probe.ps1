param([Parameter(Mandatory=$true)][string]$Root, [ValidateSet('normal','crash','insecure','policies','race')][string]$Mode = 'normal')
$ErrorActionPreference = 'Stop'
if ($env:PAC_TEST_WINDOWS_TRANSCRIPT_ACL -ne '1' -or [Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'Test-only Windows ACL probe is disabled' }
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if (-not $sid) { throw 'Owner identity unavailable' }
$rootPath = [IO.Path]::GetFullPath($Root)
if (-not [IO.Directory]::Exists($rootPath)) { throw 'Test root unavailable' }
$part = [IO.DirectoryInfo]::new($rootPath)
while ($part) {
  if (($part.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point rejected' }
  $part = $part.Parent
}
function New-PrivateSecurity([bool]$directory) {
  if ($directory) { $security = [System.Security.AccessControl.DirectorySecurity]::new() } else { $security = [System.Security.AccessControl.FileSecurity]::new() }
  $security.SetOwner($sid)
  $security.SetAccessRuleProtection($true, $false)
  if ($directory) { $inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit } else { $inherit = [System.Security.AccessControl.InheritanceFlags]::None }
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
  $security.AddAccessRule($rule)
  return $security
}
function Assert-Private($security) {
  if (-not $security.AreAccessRulesProtected -or $security.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Owner or inheritance is not private' }
  $rules = @($security.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].IsInherited -or $rules[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or $rules[0].FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { throw 'ACL is not private' }
}
if ($Mode -eq 'policies') {
  foreach ($kind in @('group', 'deny', 'inheritance', 'owner')) {
    $security = New-PrivateSecurity $false
    $group = [System.Security.Principal.SecurityIdentifier]::new([System.Security.Principal.WellKnownSidType]::BuiltinUsersSid, $null)
    switch ($kind) {
      'group' { $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($group, [System.Security.AccessControl.FileSystemRights]::Read, [System.Security.AccessControl.AccessControlType]::Allow)) }
      'deny' { $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($group, [System.Security.AccessControl.FileSystemRights]::Read, [System.Security.AccessControl.AccessControlType]::Deny)) }
      'inheritance' { $security.SetAccessRuleProtection($false, $true) }
      'owner' { $security.SetOwner($group) }
    }
    $rejected = $false
    try { Assert-Private $security } catch { $rejected = $true }
    if (-not $rejected) { throw "Policy was not rejected: $kind" }
  }
  Write-Output 'POLICIES_OK'
  return
}
$dir = Join-Path $rootPath ([Guid]::NewGuid().ToString('N'))
$stream = $null
$moved = $null
try {
  [void][IO.Directory]::CreateDirectory($dir, (New-PrivateSecurity $true))
  if ($Mode -eq 'insecure') {
    $bad = [IO.Directory]::GetAccessControl($dir)
    $everyone = [System.Security.Principal.SecurityIdentifier]::new([System.Security.Principal.WellKnownSidType]::WorldSid, $null)
    $bad.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($everyone, [System.Security.AccessControl.FileSystemRights]::Read, [System.Security.AccessControl.AccessControlType]::Allow))
    [IO.Directory]::SetAccessControl($dir, $bad)
  }
  Assert-Private ([IO.Directory]::GetAccessControl($dir))
  $path = Join-Path $dir 'synthetic.jsonl'
  $sharing = [IO.FileShare]::Read
  $options = [IO.FileOptions]::DeleteOnClose
  if ($Mode -eq 'race') { $sharing = $sharing -bor [IO.FileShare]::Delete; $options = [IO.FileOptions]::None }
  $stream = [IO.FileStream]::new($path, [IO.FileMode]::CreateNew, [System.Security.AccessControl.FileSystemRights]::FullControl, $sharing, 4096, $options, (New-PrivateSecurity $false))
  Assert-Private ($stream.GetAccessControl())
  $bytes = [Text.Encoding]::UTF8.GetBytes('PAC_SYNTHETIC_TRANSCRIPT_ONLY')
  $stream.Write($bytes, 0, $bytes.Length)
  $stream.Flush($true)
  if ($Mode -eq 'race') {
    $blocked = $false
    try { $other = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite); $other.Dispose() } catch [IO.IOException] { $blocked = $true }
    if (-not $blocked) { throw 'Concurrent write was not blocked' }
    $moved = [IO.Path]::GetFullPath($dir + '-moved')
    $verifiedDir = (Resolve-Path -LiteralPath $dir).ProviderPath
    if ([IO.Path]::GetDirectoryName($verifiedDir) -ine $rootPath -or
        [IO.Path]::GetDirectoryName($moved) -ine $rootPath) { throw 'Unexpected test move path' }
    try { [IO.Directory]::Move($verifiedDir, $moved) } catch [IO.IOException] { $moved = $null }
    if ($moved) {
      [void][IO.Directory]::CreateDirectory($dir, (New-PrivateSecurity $true))
      [IO.File]::WriteAllText($path, 'PAC_SYNTHETIC_REPLACEMENT')
      Write-Output 'RENAME_REPLACED'
    } else { Write-Output 'RENAME_BLOCKED' }
    Assert-Private ($stream.GetAccessControl())
  }
  if ($Mode -eq 'crash') {
    Write-Output ('READY ' + $dir)
    [Console]::Out.Flush()
    [Threading.Thread]::Sleep([Timeout]::Infinite)
  }
  $stream.Position = 0
  $read = [byte[]]::new($bytes.Length)
  if ($stream.Read($read, 0, $read.Length) -ne $bytes.Length -or [Text.Encoding]::UTF8.GetString($read) -ne 'PAC_SYNTHETIC_TRANSCRIPT_ONLY') { throw 'Synthetic read failed' }
  $stream.Dispose(); $stream = $null
  if ($Mode -ne 'race' -and [IO.File]::Exists($path)) { throw 'Delete-on-close failed' }
  if ($Mode -eq 'race') {
    if ($moved) {
      if (-not [IO.File]::Exists((Join-Path $moved 'synthetic.jsonl'))) { throw 'Original synthetic file disappeared' }
      if ([IO.File]::ReadAllText($path) -ne 'PAC_SYNTHETIC_REPLACEMENT') { throw 'Replacement was affected' }
      [IO.File]::Delete($path)
      [IO.File]::Delete((Join-Path $moved 'synthetic.jsonl'))
    } else { [IO.File]::Delete($path) }
  }
  Write-Output 'OK'
} finally {
  if ($stream) { $stream.Dispose() }
  if ($Mode -ne 'crash' -and [IO.Directory]::Exists($dir) -and [IO.Directory]::GetFileSystemEntries($dir).Count -eq 0) { [IO.Directory]::Delete($dir) }
  if ($moved -and [IO.Directory]::Exists($moved) -and [IO.Directory]::GetFileSystemEntries($moved).Count -eq 0) { [IO.Directory]::Delete($moved) }
}
