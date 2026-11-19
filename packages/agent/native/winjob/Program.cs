// Windows-only executable ownership for the BRC local agent.
// The user program is created SUSPENDED, assigned to a kill-on-close Job,
// and resumed only after successful assignment. The wrapper owns the Job
// handle for its lifetime; unexpected wrapper termination closes that handle.
// No credentials, arguments, or command output are logged by this runner.
//
// This is process-tree containment, NOT an ACL/restricted-token filesystem sandbox.
using System;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class Program
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint STARTF_USESHOWWINDOW = 0x00000001;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint WAIT_OBJECT_0 = 0;
    private const uint WAIT_TIMEOUT = 258;
    private const uint WAIT_FAILED = uint.MaxValue;
    private const uint STILL_ACTIVE = 259;

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        public int cb;
        public IntPtr lpReserved, lpDesktop, lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx
    {
        public StartupInfo StartupInfo;
        public IntPtr lpAttributeList;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr hProcess, hThread;
        public uint dwProcessId, dwThreadId;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInfo
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInfo
    {
        public BasicLimitInfo BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicAccountingInfo
    {
        public long TotalUserTime, TotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "CreateJobObjectW", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string? name);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass, ref ExtendedLimitInfo info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(IntPtr job, int informationClass, IntPtr info, uint length, IntPtr returnedLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "CreateProcessW", CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcess(
        string? application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint creationFlags, IntPtr environment,
        string? currentDirectory, ref StartupInfoEx startup, out ProcessInformation process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int type);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetHandleInformation(IntPtr handle, out uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr list, uint flags, IntPtr attribute, IntPtr value, UIntPtr size,
        IntPtr previous, IntPtr returnSize);
    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr list);

    private static void Require(bool ok, string operation)
    {
        if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }
    private static bool ValidHandle(IntPtr h) => h != IntPtr.Zero && h != new IntPtr(-1);
    private static uint QueryJobActiveCount(IntPtr job)
    {
        // Basic accounting fields are DWORDs after two 64-bit time counters.
        // Use an oversized unmanaged buffer for runtime ABI differences; never
        // read from it unless QueryInformationJobObject returned success.
        var memory = Marshal.AllocHGlobal(256);
        try
        {
            int lastError = 0;
            // Windows can return the 48-byte BasicAccounting V2 layout:
            // four 64-bit time counters, followed by four DWORD counters.
            // Earlier systems use the 32-byte layout with two time counters.
            foreach (uint size in new uint[] { 48, 32 })
            {
                if (QueryInformationJobObject(job, JobObjectBasicAccountingInformation, memory, size, IntPtr.Zero))
                {
                    uint total = unchecked((uint)Marshal.ReadInt32(memory, size == 48 ? 36 : 20));
                    uint active = unchecked((uint)Marshal.ReadInt32(memory, size == 48 ? 40 : 24));
                    if (active > total) throw new InvalidOperationException("Job accounting counts invalid.");
                    return active;
                }
                lastError = Marshal.GetLastWin32Error();
                if (lastError != 24 && lastError != 122) break;
            }
            throw new Win32Exception(lastError, "QueryInformationJobObject");
        }
        finally { Marshal.FreeHGlobal(memory); }
    }

    private static string Quote(string value)
    {
        if (value.Length > 0 && !value.Any(char.IsWhiteSpace) && !value.Contains('"')) return value;
        var sb = new StringBuilder("\"");
        int backslashes = 0;
        foreach (var ch in value)
        {
            if (ch == '\\') { backslashes++; continue; }
            if (ch == '"')
            {
                sb.Append('\\', backslashes * 2 + 1);
                sb.Append('"');
                backslashes = 0;
                continue;
            }
            sb.Append('\\', backslashes);
            backslashes = 0;
            sb.Append(ch);
        }
        sb.Append('\\', backslashes * 2);
        return sb.Append('"').ToString();
    }

    private static int Run(uint parentPid, string executable, string[] arguments)
    {
        if (!OperatingSystem.IsWindows()) return 122;
        // The Node parent must exist BEFORE any target is allowed to start.
        // Keep the actual kernel HANDLE so PID reuse cannot trick the watchdog.
        var parent = OpenProcess(SYNCHRONIZE, false, parentPid);
        if (!ValidHandle(parent)) throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcess(parent)");

        IntPtr job = IntPtr.Zero, list = IntPtr.Zero, handlesBlock = IntPtr.Zero;
        var target = new ProcessInformation();
        bool initialized = false;
        var originals = new (IntPtr handle, uint flags)[3];
        int originalCount = 0;
        try
        {
            if (WaitForSingleObject(parent, 0) != WAIT_TIMEOUT)
                throw new InvalidOperationException("Parent process is no longer active.");
            job = CreateJobObject(IntPtr.Zero, null);
            Require(ValidHandle(job), "CreateJobObject");
            var limits = new ExtendedLimitInfo();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            Require(SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits,
                (uint)Marshal.SizeOf<ExtendedLimitInfo>()), "SetInformationJobObject");

            var stdin = GetStdHandle(-10);
            var stdout = GetStdHandle(-11);
            var stderr = GetStdHandle(-12);
            if (!ValidHandle(stdin) || !ValidHandle(stdout) || !ValidHandle(stderr))
                throw new InvalidOperationException("Standard stream OS handles unavailable.");

            var standard = new[] { stdin, stdout, stderr }.Distinct().ToArray();
            foreach (var handle in standard)
            {
                Require(GetHandleInformation(handle, out uint flags), "GetHandleInformation");
                originals[originalCount++] = (handle, flags);
                Require(SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT),
                    "SetHandleInformation");
            }
            IntPtr bytes = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref bytes);
            if (bytes == IntPtr.Zero) throw new InvalidOperationException("No attribute list memory size.");
            list = Marshal.AllocHGlobal(bytes);
            Require(InitializeProcThreadAttributeList(list, 1, 0, ref bytes),
                "InitializeProcThreadAttributeList");
            initialized = true;
            handlesBlock = Marshal.AllocHGlobal(IntPtr.Size * standard.Length);
            for (int i = 0; i < standard.Length; i++)
                Marshal.WriteIntPtr(handlesBlock, i * IntPtr.Size, standard[i]);
            Require(UpdateProcThreadAttribute(list, 0,
                new IntPtr(PROC_THREAD_ATTRIBUTE_HANDLE_LIST), handlesBlock,
                (UIntPtr)(IntPtr.Size * standard.Length), IntPtr.Zero, IntPtr.Zero),
                "UpdateProcThreadAttribute");

            var startup = new StartupInfoEx
            {
                StartupInfo = new StartupInfo
                {
                    cb = Marshal.SizeOf<StartupInfoEx>(),
                    dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW,
                    wShowWindow = 0, // SW_HIDE (never create an unwanted console window)
                    hStdInput = stdin, hStdOutput = stdout, hStdError = stderr
                },
                lpAttributeList = list
            };
            // Explicit applicationName: no shell, no PATH interpolation, and
            // child argument quoting is Windows CRT-compatible, including quotes.
            var commandLine = new StringBuilder(Quote(executable));
            foreach (var arg in arguments) commandLine.Append(' ').Append(Quote(arg));
            Require(CreateProcess(executable, commandLine,
                    IntPtr.Zero, IntPtr.Zero, true,
                    CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
                    IntPtr.Zero, null, ref startup, out target),
                "CreateProcessW");
            // Run nothing until all descendants will inherit Job membership.
            Require(AssignProcessToJobObject(job, target.hProcess), "AssignProcessToJobObject");
            if (ResumeThread(target.hThread) == uint.MaxValue)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread");

            bool rootFinished = false;
            uint rootExitCode = 120;
            while (true)
            {
                var parentState = WaitForSingleObject(parent, 0);
                if (parentState == WAIT_OBJECT_0) return 125; // closing Job kills children
                if (parentState == WAIT_FAILED)
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForParent");
                if (!rootFinished && WaitForSingleObject(target.hProcess, 0) == WAIT_OBJECT_0)
                {
                    rootFinished = true;
                    Require(GetExitCodeProcess(target.hProcess, out rootExitCode),
                        "GetExitCodeProcess");
                }
                uint activeProcesses = QueryJobActiveCount(job);
                // Process close != descendant quiescence; only Job active count 0
                // permits success. Never claim this on a failed Job query.
                if (activeProcesses == 0)
                {
                    if (!rootFinished)
                    {
                        Require(GetExitCodeProcess(target.hProcess, out rootExitCode),
                            "GetExitCodeProcess(final)");
                        if (rootExitCode == STILL_ACTIVE)
                            throw new InvalidOperationException("Job empty before root exit observation.");
                    }
                    return unchecked((int)rootExitCode);
                }
                Thread.Sleep(40);
            }
        }
        finally
        {
            for (int i = 0; i < originalCount; i++)
            {
                var (h, flags) = originals[i];
                SetHandleInformation(h, HANDLE_FLAG_INHERIT, flags & HANDLE_FLAG_INHERIT);
            }
            if (ValidHandle(target.hThread)) CloseHandle(target.hThread);
            if (ValidHandle(target.hProcess)) CloseHandle(target.hProcess);
            if (initialized) DeleteProcThreadAttributeList(list);
            if (list != IntPtr.Zero) Marshal.FreeHGlobal(list);
            if (handlesBlock != IntPtr.Zero) Marshal.FreeHGlobal(handlesBlock);
            // LAST: owning Job handle closes on every error/exit path.
            if (ValidHandle(job)) CloseHandle(job);
            CloseHandle(parent);
        }
    }

    private static int Main(string[] argv)
    {
        try
        {
            // Usage: dotnet BrcWinJob.dll --parent <node_pid> -- <absolute.exe> [argv...]
            if (argv.Length < 4 || argv[0] != "--parent" ||
                !uint.TryParse(argv[1], out var parentPid) || parentPid == 0 ||
                argv[2] != "--" || !Path.IsPathFullyQualified(argv[3]) ||
                !File.Exists(argv[3]) ||
                !argv[3].EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("Expected --parent PID -- ABSOLUTE_EXE [arguments].");
            return Run(parentPid, Path.GetFullPath(argv[3]), argv.Skip(4).ToArray());
        }
        catch (Exception e)
        {
            // Failure is visible and never replays the program on a weaker path.
            // Do not print executable paths or sensitive command arguments.
            Console.Error.WriteLine("BRC_WINJOB_ERROR: " + e.GetType().Name +
                (e is Win32Exception w ? " OP=" + w.Message + " WIN32=" + w.NativeErrorCode : "" ) +
                (e is InvalidOperationException i ? " REASON=" + i.Message : ""));
            return 120;
        }
    }
}
