using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct StssIoCounters {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
}

[StructLayout(LayoutKind.Sequential)]
public struct StssJobBasicLimitInformation {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
}

[StructLayout(LayoutKind.Sequential)]
public struct StssJobExtendedLimitInformation {
    public StssJobBasicLimitInformation BasicLimitInformation;
    public StssIoCounters IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
}

public static class StssRunnerJob {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool CloseHandle(IntPtr handle);

    // Keep the sole, non-inheritable handle alive until this wrapper exits.
    static IntPtr jobHandle = IntPtr.Zero;

    public static bool AttachCurrentProcess() {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return false;
        var limits = new StssJobExtendedLimitInformation();
        limits.BasicLimitInformation.LimitFlags = 0x00002000; // KILL_ON_JOB_CLOSE
        int size = Marshal.SizeOf(typeof(StssJobExtendedLimitInformation));
        IntPtr memory = Marshal.AllocHGlobal(size);
        try {
            Marshal.StructureToPtr(limits, memory, false);
            if (!SetInformationJobObject(job, 9, memory, (uint)size)) {
                CloseHandle(job);
                return false;
            }
        } catch {
            CloseHandle(job);
            return false;
        } finally {
            Marshal.FreeHGlobal(memory);
        }
        if (!AssignProcessToJobObject(job, GetCurrentProcess())) {
            CloseHandle(job);
            return false;
        }
        jobHandle = job;
        return true;
    }
}
