param(
    [string]$Output = (Join-Path $PSScriptRoot '..\artifacts\harness\desktop.png'),
    [switch]$RestoreOnly
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
if (-not ('EacHarnessCapture' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class EacHarnessCapture {
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);
}
'@
}
[void][EacHarnessCapture]::SetProcessDPIAware()
$resolvedWindow = (& (Join-Path $PSScriptRoot 'resolve-harness.ps1') -Show) | ConvertFrom-Json
$harnessWindow = [PSCustomObject]@{ Id = $resolvedWindow.Id; MainWindowHandle = [IntPtr][long]$resolvedWindow.Hwnd }
[void][EacHarnessCapture]::ShowWindow($harnessWindow.MainWindowHandle, 9)
[void][EacHarnessCapture]::SetForegroundWindow($harnessWindow.MainWindowHandle)
Start-Sleep -Milliseconds 500
if ($RestoreOnly) { return }
$captureRect = New-Object EacHarnessCapture+Rect
if (-not [EacHarnessCapture]::GetWindowRect($harnessWindow.MainWindowHandle, [ref]$captureRect)) { throw 'Cannot measure Harness window.' }
$captureWidth = $captureRect.Right - $captureRect.Left
$captureHeight = $captureRect.Bottom - $captureRect.Top
if ($captureWidth -le 0 -or $captureHeight -le 0) { throw 'Harness window has no visible dimensions.' }
$capturePath = [IO.Path]::GetFullPath($Output)
New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($capturePath)) -Force | Out-Null
$captureBitmap = New-Object Drawing.Bitmap($captureWidth, $captureHeight)
$captureGraphics = [Drawing.Graphics]::FromImage($captureBitmap)
try {
    $captureDc = $captureGraphics.GetHdc()
    try { $printed = [EacHarnessCapture]::PrintWindow($harnessWindow.MainWindowHandle, $captureDc, 2) }
    finally { $captureGraphics.ReleaseHdc($captureDc) }
    if (-not $printed) { throw 'Window capture failed; no desktop or lock-screen image was substituted.' }
    $captureBitmap.Save($capturePath, [Drawing.Imaging.ImageFormat]::Png)
    [PSCustomObject]@{ Path = $capturePath; Width = $captureWidth; Height = $captureHeight; ProcessId = $harnessWindow.Id }
} finally {
    $captureGraphics.Dispose()
    $captureBitmap.Dispose()
}
