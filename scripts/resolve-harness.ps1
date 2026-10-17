param([int]$ExpectedProcessId = 0, [switch]$Show)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class EacHarnessWindow {
    public delegate bool Callback(IntPtr hwnd, IntPtr data);
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
    [DllImport("user32.dll")] public static extern bool EnumWindows(Callback cb,IntPtr data);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd,StringBuilder name,int count);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd,out Rect rect);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd,int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
    public static List<IntPtr> Find(uint pid) {
        var result=new List<IntPtr>();
        EnumWindows((h,d)=>{uint owner;GetWindowThreadProcessId(h,out owner);var c=new StringBuilder(128);GetClassName(h,c,128);
            Rect r;GetClientRect(h,out r);
            if(owner==pid && c.ToString()=="Chrome_WidgetWin_1" && r.Right>=100 && r.Bottom>=100)result.Add(h);
            return true;},IntPtr.Zero);return result;
    }
}
'@
[void][EacHarnessWindow]::SetProcessDPIAware()
$candidates = @()
foreach ($process in (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)) {
    if ($ExpectedProcessId -ne 0 -and $process.Id -ne $ExpectedProcessId) { continue }
    foreach ($handle in [EacHarnessWindow]::Find($process.Id)) {
        $rect = New-Object EacHarnessWindow+Rect
        [void][EacHarnessWindow]::GetClientRect($handle, [ref]$rect)
        $candidates += [PSCustomObject]@{ Id=$process.Id; Hwnd=$handle.ToInt64(); Width=$rect.Right; Height=$rect.Bottom; Dpi=[EacHarnessWindow]::GetDpiForWindow($handle) }
    }
}
$chosen = $candidates | Sort-Object { $_.Width * $_.Height } -Descending | Select-Object -First 1
if (-not $chosen) { throw 'No Harness product window was found.' }
if ($Show) {
    [void][EacHarnessWindow]::ShowWindow([IntPtr]$chosen.Hwnd,9)
    [void][EacHarnessWindow]::SetForegroundWindow([IntPtr]$chosen.Hwnd)
}
$chosen | ConvertTo-Json -Compress
