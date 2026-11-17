if(-not ('PacRuntimeHandlePath' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class PacRuntimeHandlePath {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint size, uint flags);
}
'@
}
function Assert-PacHandlePath([IO.FileStream]$Stream,[string]$Path) {
  $buffer=[Text.StringBuilder]::new(32768)
  $length=[PacRuntimeHandlePath]::GetFinalPathNameByHandle($Stream.SafeFileHandle,$buffer,[uint32]$buffer.Capacity,0)
  if($length -eq 0 -or $length -ge $buffer.Capacity){throw 'Could not verify the runtime file handle.'}
  $actual=$buffer.ToString()
  if($actual.StartsWith('\\?\UNC\',[StringComparison]::OrdinalIgnoreCase)){$actual='\\'+$actual.Substring(8)}
  elseif($actual.StartsWith('\\?\')){$actual=$actual.Substring(4)}
  $expected=[IO.Path]::GetFullPath($Path)
  if([IO.Path]::GetFullPath($actual) -ine $expected){throw 'Runtime.ps1 resolves through an unexpected path.'}
}
function Read-PacLockedBytes([string]$Path) {
  $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)
  try {
    Assert-PacHandlePath $stream $Path
    $buffer=[IO.MemoryStream]::new()
    try { $stream.CopyTo($buffer); return ,$buffer.ToArray() } finally { $buffer.Dispose() }
  } finally { $stream.Dispose() }
}
function Set-PacLockedBytes([string]$Path,[string]$Expected,[byte[]]$Replacement) {
  throw 'Runtime update disabled: crash-safe recovery is not yet established.'
}
