function Export-ProviderRevision {
  param([Parameter(Mandatory=$true)][string]$Source, [Parameter(Mandatory=$true)][string]$Revision, [Parameter(Mandatory=$true)][string]$Destination)
  if ($Revision -cnotmatch '^[0-9a-f]{40}$') { throw 'Invalid provider revision.' }
  $sourcePath = (Resolve-Path -LiteralPath $Source).ProviderPath
  $target = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Destination).ProviderPath)
  if ([IO.Directory]::GetFileSystemEntries($target).Length -ne 0) { throw 'Provider export destination must be empty.' }
  $part = [IO.DirectoryInfo]::new($target)
  while ($part) { if (($part.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Provider export reparse point rejected.' }; $part = $part.Parent }
  $git = (Get-Command git.exe -CommandType Application -ErrorAction Stop).Source
  function Get-RevisionBytes([string]$Arguments, [int]$Limit) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $git; $info.WorkingDirectory = $sourcePath
    $info.Arguments = '-c core.autocrlf=false ' + $Arguments
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $info
    $memory = [IO.MemoryStream]::new()
    $started = $false
    try {
      $started = $process.Start(); if (!$started) { throw 'Provider Git export could not start.' }
      $errors = $process.StandardError.ReadToEndAsync()
      $buffer = [byte[]]::new(65536)
      while (($length = $process.StandardOutput.BaseStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
        if ($memory.Length + $length -gt $Limit) { throw 'Provider Git export exceeds the size limit.' }
        $memory.Write($buffer, 0, $length)
      }
      $process.WaitForExit()
      [void]$errors.GetAwaiter().GetResult()
      if ($process.ExitCode -ne 0) { throw 'Provider Git export failed.' }
      return ,$memory.ToArray()
    } finally {
      if ($started -and !$process.HasExited) { $process.Kill(); [void]$process.WaitForExit(10000) }
      $memory.Dispose(); $process.Dispose()
    }
  }
  $paths = ' -- adapters src source-package/package.json source-package/package-lock.json'
  $tree = [Text.UTF8Encoding]::new($false, $true).GetString((Get-RevisionBytes ('ls-tree -r -z --full-tree ' + $Revision + $paths) 4194304))
  $files = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  $windowsNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $casePaths = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($record in $tree.Split([char]0)) {
    if (!$record) { continue }
    if ($record -cnotmatch '^(100644|100755) blob [0-9a-f]{40}\t(.+)$') { throw 'Unsupported provider Git entry.' }
    $name = $Matches[2]
    $partial = ''
    foreach ($piece in $name.Split('/')) {
      if (!$piece -or $piece -in @('.', '..') -or $piece -match '[<>:"\\|?*\x00-\x1f]' -or $piece -match '[ .]$' -or $piece -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { throw 'Unsafe provider Git path.' }
      $partial = if ($partial) { $partial + '/' + $piece } else { $piece }
      $previous = $null
      if ($casePaths.TryGetValue($partial, [ref]$previous)) { if ($previous -cne $partial) { throw 'Ambiguous provider Git path.' } }
      else { $casePaths.Add($partial, $partial) }
    }
    if (!$files.Add($name) -or !$windowsNames.Add($name)) { throw 'Ambiguous provider Git path.' }
  }
  foreach ($required in @('source-package/package.json', 'source-package/package-lock.json', 'adapters/install-hapi-command.mjs')) {
    if (!$files.Contains($required)) { throw 'Provider revision is missing required entrypoints.' }
  }
  Add-Type -AssemblyName System.IO.Compression
  $bytes = Get-RevisionBytes ('archive --format=zip ' + $Revision + $paths) 67108864
  $memory = [IO.MemoryStream]::new($bytes, $false)
  $zip = [IO.Compression.ZipArchive]::new($memory, [IO.Compression.ZipArchiveMode]::Read)
  try {
    $written = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    [long]$expanded = 0
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName
      if ($name.EndsWith('/')) { continue }
      if (!$files.Contains($name) -or !$written.Add($name) -or $entry.Length -gt 16777216) { throw 'Unexpected provider archive entry.' }
      $expanded += $entry.Length
      if ($expanded -gt 134217728) { throw 'Provider export exceeds the expanded size limit.' }
      $path = [IO.Path]::GetFullPath((Join-Path $target $name))
      if (!$path.StartsWith($target.TrimEnd([char]92) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe provider export destination.' }
      [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path))
      $input = $entry.Open(); $output = $null
      try { $output = [IO.FileStream]::new($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None); $input.CopyTo($output); $output.Flush($true) }
      finally { if ($output) { $output.Dispose() }; $input.Dispose() }
    }
    if ($written.Count -ne $files.Count) { throw 'Provider archive omitted required tracked files.' }
  } finally { $zip.Dispose(); $memory.Dispose() }
}
