param([Parameter(Mandatory=$true)][string]$EncodedSpec)
$ErrorActionPreference = 'Stop'
$spec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EncodedSpec)) | ConvertFrom-Json
$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class PacTestOwnedJob {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    struct StartupInfo {
        public uint cb;
        public string lpReserved, lpDesktop, lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct StartupInfoEx { public StartupInfo StartupInfo; public IntPtr AttributeList; }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }

    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetStdHandle(int handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [StructLayout(LayoutKind.Sequential)]
    struct BasicAccounting { public long TotalUserTime, TotalKernelTime, ThisPeriodUserTime, ThisPeriodKernelTime; public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr data, uint length, IntPtr returned);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);


    static void Require(bool value) { if (!value) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static string Quote(string value) {
        if (value.Length > 0 && value.IndexOfAny(new char[] {' ', '\t', '\n', '\v', '"'}) < 0) return value;
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value) {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); slashes = 0; continue; }
            result.Append('\\', slashes); slashes = 0; result.Append(character);
        }
        result.Append('\\', slashes * 2); result.Append('"');
        return result.ToString();
    }

    public static int Run(string executable, string[] arguments, string directory, bool interactive, string nonce, int deadlineMs) {
        IntPtr job = IntPtr.Zero, limits = IntPtr.Zero, attributes = IntPtr.Zero, jobs = IntPtr.Zero, nullHandle = IntPtr.Zero;
        bool initialized = false;
        ProcessInfo process = new ProcessInfo();
        try {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            var settings = new ExtendedLimits();
            settings.BasicLimitInformation.LimitFlags = 0x2000;
            int length = Marshal.SizeOf(typeof(ExtendedLimits));
            limits = Marshal.AllocHGlobal(length);
            Marshal.StructureToPtr(settings, limits, false);
            Require(SetInformationJobObject(job, 9, limits, (uint)length));
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            if (size == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            attributes = Marshal.AllocHGlobal(size);
            Require(InitializeProcThreadAttributeList(attributes, 1, 0, ref size));
            initialized = true;
            jobs = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobs, job);
            Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x0002000D), jobs, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
            var startup = new StartupInfoEx();
            startup.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(StartupInfoEx));
            startup.StartupInfo.dwFlags = 0x100;
            nullHandle = CreateFile("NUL", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
            if (nullHandle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
            startup.StartupInfo.hStdInput = nullHandle;
            startup.StartupInfo.hStdOutput = nullHandle;
            startup.StartupInfo.hStdError = nullHandle;
            foreach (IntPtr handle in new IntPtr[] { startup.StartupInfo.hStdInput, startup.StartupInfo.hStdOutput, startup.StartupInfo.hStdError }) {
                if (handle != IntPtr.Zero && handle != new IntPtr(-1)) Require(SetHandleInformation(handle, 1, 1));
            }
            startup.AttributeList = attributes;
            var command = new StringBuilder(Quote(executable));
            foreach (string argument in arguments) command.Append(' ').Append(Quote(argument));
            Require(CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x00080004 | (interactive ? 0u : 0x08000000u), IntPtr.Zero, directory, ref startup, out process));
            if (ResumeThread(process.Thread) == uint.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
            Console.Out.WriteLine("OWNED_READY " + nonce);
            Console.Out.Flush();
            string signal = System.IO.Path.Combine(directory, "stop.signal");
            var controlDeadline = DateTime.UtcNow.AddMilliseconds(deadlineMs);
            bool earlyReported = false;
            while (true) {
                if (!earlyReported && WaitForSingleObject(process.Process, 0) == 0) {
                    Console.Out.WriteLine("OWNED_EARLY_EXIT " + nonce);
                    Console.Out.Flush();
                    earlyReported = true;
                }
                string requested = null;
                // Atomic replacement can remove the old signal between Exists
                // and ReadAllText. A missing signal is not a stop or host failure.
                try { requested = System.IO.File.ReadAllText(signal).Trim(); }
                catch (System.IO.FileNotFoundException) { }
                catch (System.IO.DirectoryNotFoundException) { }
                if (requested == nonce) break;
                if (DateTime.UtcNow >= controlDeadline) throw new InvalidOperationException("Owned job control unavailable");
                System.Threading.Thread.Sleep(50);
            }
            Require(TerminateJobObject(job, 1));
            if (WaitForSingleObject(process.Process, 15000) != 0) throw new InvalidOperationException("Owned process exit unconfirmed");
            int accountingSize = Marshal.SizeOf(typeof(BasicAccounting));
            IntPtr accountingBuffer = Marshal.AllocHGlobal(accountingSize);
            try {
                var deadline = DateTime.UtcNow.AddSeconds(15);
                while (true) {
                    Require(QueryInformationJobObject(job, 1, accountingBuffer, (uint)accountingSize, IntPtr.Zero));
                    var accounting = (BasicAccounting)Marshal.PtrToStructure(accountingBuffer, typeof(BasicAccounting));
                    if (accounting.ActiveProcesses == 0) break;
                    if (DateTime.UtcNow >= deadline) throw new InvalidOperationException("Owned job exit unconfirmed");
                    System.Threading.Thread.Sleep(50);
                }
            } finally { Marshal.FreeHGlobal(accountingBuffer); }
            Console.Out.WriteLine("OWNED_CLOSED " + nonce);
            Console.Out.Flush();
            return 0;
        } finally {
            if (nullHandle != IntPtr.Zero && nullHandle != new IntPtr(-1)) CloseHandle(nullHandle);
            if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
            if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
            if (initialized) DeleteProcThreadAttributeList(attributes);
            if (jobs != IntPtr.Zero) Marshal.FreeHGlobal(jobs);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (limits != IntPtr.Zero) Marshal.FreeHGlobal(limits);
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
$requested = [string]$spec.command
if (Test-Path -LiteralPath $requested -PathType Leaf) {
    $executable = (Resolve-Path -LiteralPath $requested).ProviderPath
} else {
    if ([System.Management.Automation.WildcardPattern]::ContainsWildcardCharacters($requested)) { throw 'Wildcard executable names are unsupported' }
    $executable = (Get-Command -Name $requested -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
}
if ([IO.Path]::GetExtension($executable) -ine '.exe' -and [IO.Path]::GetExtension($executable) -ine '.com') { throw 'Unsupported Windows executable type' }
if ([string]$spec.nonce -cnotmatch '^[a-f0-9]{32}$') { throw 'Invalid owned job nonce' }
$deadlineMs = 1800000
if ($null -ne $spec.deadlineMs) {
  if ($spec.deadlineMs -isnot [int] -and $spec.deadlineMs -isnot [long]) { throw 'Invalid owned job deadline' }
  if ($spec.deadlineMs -lt 1000 -or $spec.deadlineMs -gt 1800000) { throw 'Invalid owned job deadline' }
  $deadlineMs = [int]$spec.deadlineMs
}
$result = [PacTestOwnedJob]::Run($executable, [string[]]@($spec.args), [string]$spec.cwd, $false, [string]$spec.nonce, $deadlineMs)
exit $result
