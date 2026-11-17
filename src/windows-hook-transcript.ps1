$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class PacPrivateTranscript {
    const int Limit = 1048576;
    [StructLayout(LayoutKind.Sequential)] struct FileInfo {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {
        public int Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateDirectory(string path, ref SecurityAttributes security);
    static SecurityIdentifier User { get { return WindowsIdentity.GetCurrent().User; } }
    static void Check(bool value, string stage = "policy") { if (!value) { var error = new IOException("Private transcript handle unavailable"); error.Data["PAC_STAGE"] = stage; throw error; } }
    static FileInfo Information(SafeFileHandle handle) { FileInfo info; Check(GetFileInformationByHandle(handle, out info)); return info; }
    static string FinalPath(SafeFileHandle handle) {
        var text = new StringBuilder(4096); uint size = GetFinalPathNameByHandle(handle, text, (uint)text.Capacity, 0);
        Check(size > 0 && size < text.Capacity);
        string path = text.ToString();
        if (path.StartsWith(@"\\?\")) path = path.Substring(4);
        return path.TrimEnd('\\');
    }
    static string Local(string path) {
        string full = Path.GetFullPath(path);
        Check(full.Length >= 3 && char.IsLetter(full[0]) && full[1] == ':' && full[2] == '\\');
        var drive = new DriveInfo(full.Substring(0, 3));
        Check(drive.DriveType == DriveType.Fixed && drive.DriveFormat == "NTFS");
        return full;
    }
    public sealed class Pins : IDisposable {
        readonly List<SafeFileHandle> handles = new List<SafeFileHandle>();
        public string Path { get; private set; }
        public Pins(string directory) {
            try {
                string full = Local(directory), current = full.Substring(0, 3);
                Add(current);
                foreach (string part in full.Substring(3).Split(new char[] {'\\'}, StringSplitOptions.RemoveEmptyEntries)) {
                    current = System.IO.Path.Combine(current, part); Add(current);
                }
                Path = FinalPath(handles[handles.Count - 1]);
            } catch { Dispose(); throw; }
        }
        void Add(string path) {
            var handle = CreateFile(path, 0x80, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
            if (handle.IsInvalid) { handle.Dispose(); throw new IOException("Private transcript directory unavailable"); }
            handles.Add(handle); var info = Information(handle);
            Check((info.Attributes & 0x400) == 0 && (info.Attributes & 0x10) != 0);
        }
        public void Dispose() { for (int i=handles.Count-1; i>=0; i--) handles[i].Dispose(); handles.Clear(); }
    }
    static FileSystemSecurity Security(bool directory) {
        FileSystemSecurity security = directory ? (FileSystemSecurity)new DirectorySecurity() : new FileSecurity();
        security.SetOwner(User); security.SetAccessRuleProtection(true, false);
        var inheritance = directory ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit : InheritanceFlags.None;
        security.AddAccessRule(new FileSystemAccessRule(User, FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
        return security;
    }
    static void Private(FileSystemSecurity security, bool strict) {
        var owner = security.GetOwner(typeof(SecurityIdentifier));
        // Newly created SDK files can use the token default owner (a group SID).
        // The keeper still requires its explicitly assigned user SID.
        Check(owner.Equals(User) || (!strict && owner.Equals(WindowsIdentity.GetCurrent().Owner)), "owner");
        var rules = security.GetAccessRules(true, true, typeof(SecurityIdentifier)); Check(rules.Count > 0, "acl");
        if (strict) Check(security.AreAccessRulesProtected && rules.Count == 1, "acl");
        foreach (FileSystemAccessRule rule in rules) {
            string sid = rule.IdentityReference.Value;
            Check(rule.AccessControlType == AccessControlType.Allow, "acl");
            Check(sid == User.Value || (!strict && (sid == "S-1-5-18" || sid == "S-1-5-32-544")), "acl");
            if (strict) Check(!rule.IsInherited && rule.FileSystemRights == FileSystemRights.FullControl);
        }
    }
    public static string Snapshot(string path, string root) {
        string full = Local(path);
        using (var roots = new Pins(root)) using (var parents = new Pins(System.IO.Path.GetDirectoryName(full))) {
            var handle = CreateFile(full, 0x80020000, 1, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero);
            if (handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error(), "Private transcript file unavailable"); }
            using (var file = new FileStream(handle, FileAccess.Read)) {
                var info = Information(handle);
                Check((info.Attributes & 0x410) == 0 && info.Links == 1 && (((ulong)info.SizeHigh << 32) | info.SizeLow) <= Limit);
                Check(FinalPath(handle).StartsWith(roots.Path + "\\", StringComparison.OrdinalIgnoreCase), "path");
                Private(file.GetAccessControl(), false);
                byte[] bytes = new byte[Limit + 1]; int length = 0, count;
                while (length < bytes.Length && (count = file.Read(bytes, length, bytes.Length-length)) > 0) length += count;
                Check(length <= Limit); return Convert.ToBase64String(bytes, 0, length);
            }
        }
    }
    public sealed class Keeper : IDisposable {
        Pins parents, directoryPins; FileStream file; string directory; bool created;
        public string Path { get; private set; }
        public Keeper(string root, byte[] bytes) {
            Check(bytes.Length <= Limit);
            try {
                parents = new Pins(root);
                directory = System.IO.Path.Combine(parents.Path, "pac-hook-transcript-" + Guid.NewGuid().ToString("N"));
                byte[] descriptor = Security(true).GetSecurityDescriptorBinaryForm();
                IntPtr memory = Marshal.AllocHGlobal(descriptor.Length);
                try {
                    Marshal.Copy(descriptor, 0, memory, descriptor.Length);
                    var attributes = new SecurityAttributes { Length=Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor=memory, Inherit=false };
                    Check(CreateDirectory(directory, ref attributes)); created=true;
                } finally { Marshal.FreeHGlobal(memory); }
                directoryPins = new Pins(directory);
                Private(Directory.GetAccessControl(directory), true);
                Path = System.IO.Path.Combine(directory, "transcript.jsonl");
                file = new FileStream(Path, FileMode.CreateNew, FileSystemRights.FullControl, FileShare.Read, 4096, FileOptions.DeleteOnClose, (FileSecurity)Security(false));
                Private(file.GetAccessControl(), true);
                file.Write(bytes, 0, bytes.Length); file.Flush(true);
            } catch { Dispose(); throw; }
        }
        public void Dispose() {
            try { if (file != null) { file.Dispose(); file=null; } }
            finally {
                try { if (directoryPins != null) { directoryPins.Dispose(); directoryPins=null; } if (created) { Directory.Delete(directory, false); created=false; } }
                finally { if (parents != null) { parents.Dispose(); parents=null; } }
            }
        }
    }
}

'@
Add-Type -TypeDefinition $source -Language CSharp
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false, $true)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$reader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false, $true))
$line = $reader.ReadLine()
if (!$line -or $line.Length -gt 1500000) { throw 'Invalid private transcript request' }
$request = $line | ConvertFrom-Json
try {
if ($request.operation -ceq 'snapshot') {
  $snapshot = [PacPrivateTranscript]::Snapshot([string]$request.path, [string]$request.root)
  [Console]::Out.WriteLine((@{snapshot=$snapshot}|ConvertTo-Json -Compress)); [Console]::Out.Flush()
} elseif ($request.operation -ceq 'hold') {
  $keeper = [PacPrivateTranscript+Keeper]::new([string]$request.root, [Convert]::FromBase64String([string]$request.transcript))
  try {
    [Console]::Out.WriteLine((@{path=$keeper.Path}|ConvertTo-Json -Compress)); [Console]::Out.Flush()
    [void]$reader.ReadLine()
  } finally { $keeper.Dispose() }
} else { throw 'Invalid private transcript operation' }

} catch {
  $errorValue=$_.Exception
  while($errorValue.InnerException){$errorValue=$errorValue.InnerException}
  $stage=[string]$errorValue.Data["PAC_STAGE"]
  if($stage -notin @("owner","acl","path","policy")){$stage="host"}
  $code=if($errorValue -is [ComponentModel.Win32Exception]){[int]$errorValue.NativeErrorCode}else{-1}
  [Console]::Out.WriteLine((@{error=$code;stage=$stage}|ConvertTo-Json -Compress));[Console]::Out.Flush()
  exit 1
}
