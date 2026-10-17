param([switch]$Restart)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class EacRecovery {
    public delegate bool Callback(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll")] public static extern bool EnumWindows(Callback cb, IntPtr data);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, Callback cb, IntPtr data);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hwnd);
    public static string Text(IntPtr hwnd) { var s = new StringBuilder(4096); GetWindowText(hwnd,s,s.Capacity); return s.ToString(); }
    public static string Class(IntPtr hwnd) { var s = new StringBuilder(128); GetClassName(hwnd,s,s.Capacity); return s.ToString(); }
    public static List<IntPtr> Windows(uint pid) {
        var windows = new List<IntPtr>();
        EnumWindows((h,d)=>{uint p;GetWindowThreadProcessId(h,out p);if(p==pid)windows.Add(h);return true;},IntPtr.Zero);
        return windows;
    }
    public static List<IntPtr> Children(IntPtr parent) {
        var windows = new List<IntPtr>();
        EnumChildWindows(parent,(h,d)=>{windows.Add(h);return true;},IntPtr.Zero);
        return windows;
    }
}
'@
$target = Get-Process -Name 'DeepSeek Harness' | Where-Object MainWindowHandle -ne 0 | Select-Object -First 1
if (-not $target) { throw 'Harness main process is unavailable.' }
$found = $false
foreach ($window in [EacRecovery]::Windows($target.Id)) {
    if ([EacRecovery]::Class($window) -ne '#32770') { continue }
    $caption = [EacRecovery]::Text($window)
    $buttons = @()
    foreach ($child in [EacRecovery]::Children($window)) {
        $text = [EacRecovery]::Text($child)
        if ([EacRecovery]::Class($child) -eq 'Button') {
            $buttons += "$text [$([EacRecovery]::GetDlgCtrlID($child))]"
            if ($Restart -and $caption -match 'DeepSeek|Harness' -and $text -match '^(\u91cd\u542f|Restart)(&[A-Za-z])?$') {
                $controlId = [EacRecovery]::GetDlgCtrlID($child)
                [void][EacRecovery]::PostMessage($window, 0x0111, [IntPtr]$controlId, $child)
                [void][EacRecovery]::PostMessage($window, 0x0466, [IntPtr]$controlId, [IntPtr]::Zero)
                $found = $true
            }
        }
    }
    [PSCustomObject]@{ Window = $caption; Buttons = ($buttons -join ', '); RestartRequested = $found }
}
if ($Restart -and -not $found) { throw 'No official restart button was found; no other action was taken.' }
