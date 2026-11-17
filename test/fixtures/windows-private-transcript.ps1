param([string]$Root, [ValidateSet('private','token-owner','directory','broad','large')][string]$Mode='private')
$ErrorActionPreference='Stop'
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$dir=[Security.AccessControl.DirectorySecurity]::new()
$dir.SetOwner($sid);$dir.SetAccessRuleProtection($true,$false)
$dir.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
[IO.Directory]::SetAccessControl($Root,$dir)
if($Mode -eq 'directory'){exit 0}
$security=[Security.AccessControl.FileSecurity]::new()
$owner=if($Mode -eq 'token-owner'){[Security.Principal.WindowsIdentity]::GetCurrent().Owner}else{$sid}
$security.SetOwner($owner);$security.SetAccessRuleProtection($true,$false)
$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow))
if($Mode -eq 'broad') {
 $world=[Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::WorldSid,$null)
 $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($world,[Security.AccessControl.FileSystemRights]::Read,[Security.AccessControl.AccessControlType]::Allow))
}
$file=[IO.FileStream]::new((Join-Path $Root 'session.jsonl'),[IO.FileMode]::CreateNew,[Security.AccessControl.FileSystemRights]::FullControl,[IO.FileShare]::None,4096,[IO.FileOptions]::None,$security)
try {
 $bytes=if($Mode -eq 'large'){[byte[]]::new(1048577)}else{[Text.Encoding]::UTF8.GetBytes('SYNTHETIC_PRIVATE_TRANSCRIPT')}
 $file.Write($bytes,0,$bytes.Length)
}finally{$file.Dispose()}
