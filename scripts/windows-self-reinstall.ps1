<#
.SYNOPSIS
Runs the assisted ParadigmEve installer using its default choices, survives the app shutdown,
then relaunches/reconnects the installed build.

.DESCRIPTION
This controller intentionally runs outside ParadigmEve. That is the important property: the
installer is allowed to close the running tray app without also killing the process that is
driving the rest of the installation.

The assisted installer stays visible. The script clicks only the known forward/default actions
(Next, Install, the app-running prompt's OK, Retry after a verified close, and Finish). It never
chooses a destructive alternative such as Ignore/Cancel and it never changes the install folder
or per-user/per-machine default.

After installation, the script launches/signals the installed app in the foreground with the
one-shot --connect-on-start and --recover-companion-browser flags. Foreground launch deliberately
lets the normal ParadigmEve window startup path present the app (maximized on initial creation)
while the one-shot flags restore connectivity and the Companion browser. Recovery is retried every
30 seconds for at most two minutes by default.
#>
[CmdletBinding()]
param(
  [string]$InstallerPath,
  [int]$RetrySeconds = 30,
  [int]$RecoverySeconds = 120,
  [int]$InstallerTimeoutSeconds = 600,
  [string]$LogPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $InstallerPath) {
  $InstallerPath = Join-Path $PSScriptRoot '..\release\ParadigmEve-Windows-x64.exe'
}
if (-not $LogPath) {
  $LogPath = Join-Path $PSScriptRoot '..\build\self-reinstall.log'
}

if ($RetrySeconds -lt 1) { throw 'RetrySeconds must be at least 1.' }
if ($RecoverySeconds -lt $RetrySeconds) { throw 'RecoverySeconds must be at least RetrySeconds.' }
if ($InstallerTimeoutSeconds -lt 30) { throw 'InstallerTimeoutSeconds must be at least 30.' }

# The controller intentionally survives ParadigmEve's own shutdown, which also means an MCP/tool
# reconnect can accidentally start the same installer a second time while the first controller is
# still recovering the browser. Hold one OS file handle for this process lifetime; the kernel
# releases it automatically if this PowerShell process exits or crashes, so a later legitimate
# reinstall is never blocked by a stale file on disk.
$controllerLockPath = Join-Path $env:TEMP 'ParadigmEve-self-reinstall.lock'
try {
  $controllerLock = [IO.File]::Open($controllerLockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
} catch [IO.IOException] {
  throw 'Another ParadigmEve self-reinstall controller is already running. Wait for it to finish instead of starting the installer again.'
}

$installer = [IO.Path]::GetFullPath($InstallerPath)
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
  throw "Installer not found: $installer"
}

$logFile = [IO.Path]::GetFullPath($LogPath)
$logDir = Split-Path -Parent $logFile
if (-not (Test-Path -LiteralPath $logDir -PathType Container)) {
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

function Write-ReinstallLog([string]$Message) {
  $line = '{0}  {1}' -f ([DateTimeOffset]::Now.ToString('o')), $Message
  Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
  Write-Output $line
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class ParadigmEveInstallerUi {
    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")]
    private static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

    private const uint BM_CLICK = 0x00F5;

    private static string Text(IntPtr hwnd) {
        var text = new StringBuilder(2048);
        GetWindowText(hwnd, text, text.Capacity);
        return text.ToString();
    }

    private static string ClassName(IntPtr hwnd) {
        var text = new StringBuilder(128);
        GetClassName(hwnd, text, text.Capacity);
        return text.ToString();
    }

    private static IEnumerable<IntPtr> TopWindows(uint processId) {
        var windows = new List<IntPtr>();
        EnumWindows((hwnd, _) => {
            uint owner;
            GetWindowThreadProcessId(hwnd, out owner);
            if (owner == processId && IsWindowVisible(hwnd)) windows.Add(hwnd);
            return true;
        }, IntPtr.Zero);
        return windows;
    }

    public static string Snapshot(uint processId) {
        var rows = new List<string>();
        foreach (var top in TopWindows(processId)) {
            rows.Add("WINDOW " + Text(top));
            EnumChildWindows(top, (hwnd, _) => {
                if (!IsWindowVisible(hwnd)) return true;
                var cls = ClassName(hwnd);
                if (cls == "Button" || cls == "Static" || cls == "Edit") {
                    var text = Text(hwnd);
                    if (!String.IsNullOrWhiteSpace(text)) {
                        rows.Add(cls + " " + text.Replace("\r", " ").Replace("\n", " "));
                    }
                }
                return true;
            }, IntPtr.Zero);
        }
        return String.Join(" | ", rows.ToArray());
    }

    public static bool ClickButton(uint processId, string needle) {
        IntPtr target = IntPtr.Zero;
        foreach (var top in TopWindows(processId)) {
            EnumChildWindows(top, (hwnd, _) => {
                if (target != IntPtr.Zero) return false;
                if (!IsWindowVisible(hwnd) || !IsWindowEnabled(hwnd) || ClassName(hwnd) != "Button") return true;
                var text = Text(hwnd);
                if (text.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) {
                    target = hwnd;
                    return false;
                }
                return true;
            }, IntPtr.Zero);
            if (target != IntPtr.Zero) break;
        }
        if (target == IntPtr.Zero) return false;
        return PostMessage(target, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
    }

    public static bool HasButton(uint processId, string needle) {
        foreach (var top in TopWindows(processId)) {
            var found = false;
            EnumChildWindows(top, (hwnd, _) => {
                if (!IsWindowVisible(hwnd) || !IsWindowEnabled(hwnd) || ClassName(hwnd) != "Button") return true;
                var text = Text(hwnd);
                if (text.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) {
                    found = true;
                    return false;
                }
                return true;
            }, IntPtr.Zero);
            if (found) return true;
        }
        return false;
    }
}
'@

function Get-ParadigmEveProcesses {
  @(Get-Process -Name 'ParadigmEve' -ErrorAction SilentlyContinue)
}

function Stop-ParadigmEveFallback {
  $running = @(Get-ParadigmEveProcesses)
  if ($running.Count -eq 0) { return }
  Write-ReinstallLog "Installer close request did not retire all ParadigmEve processes in time; force-stopping $($running.Count) remaining process(es)."
  $running | Stop-Process -Force -ErrorAction Stop
}

Write-ReinstallLog "Starting assisted installer: $installer"
$installerProcess = Start-Process -FilePath $installer -PassThru
$installerDeadline = [DateTimeOffset]::Now.AddSeconds($InstallerTimeoutSeconds)
$closeFallbackAt = $null
$lastSnapshot = ''
$actedSnapshot = ''

while (-not $installerProcess.HasExited) {
  if ([DateTimeOffset]::Now -ge $installerDeadline) {
    throw "Installer did not finish within $InstallerTimeoutSeconds seconds. Last state: $lastSnapshot"
  }

  $installerProcess.Refresh()
  $snapshot = [ParadigmEveInstallerUi]::Snapshot([uint32]$installerProcess.Id)
  if ($snapshot -and $snapshot -ne $lastSnapshot) {
    Write-ReinstallLog "Installer state: $snapshot"
    $lastSnapshot = $snapshot
    $actedSnapshot = ''
  }

  if ($closeFallbackAt -and [DateTimeOffset]::Now -ge $closeFallbackAt) {
    Stop-ParadigmEveFallback
    $closeFallbackAt = $null
  }

  if ($snapshot -and $snapshot -ne $actedSnapshot) {
    $acted = $false
    if ($snapshot -match 'ParadigmEve is running') {
      Write-ReinstallLog 'Attempting installer action: close running ParadigmEve.'
      $acted = [ParadigmEveInstallerUi]::ClickButton([uint32]$installerProcess.Id, 'OK')
      if ($acted) {
        Write-ReinstallLog 'Accepted installer request to close the running ParadigmEve tray app.'
        $closeFallbackAt = [DateTimeOffset]::Now.AddSeconds(15)
      }
    } elseif ([ParadigmEveInstallerUi]::HasButton([uint32]$installerProcess.Id, 'Finish')) {
      Write-ReinstallLog 'Attempting installer action: Finish.'
      $acted = [ParadigmEveInstallerUi]::ClickButton([uint32]$installerProcess.Id, 'Finish')
      if ($acted) { Write-ReinstallLog 'Accepted default Finish action; installer may launch ParadigmEve.' }
    } elseif ($snapshot -match 'Installation Complete' -and [ParadigmEveInstallerUi]::HasButton([uint32]$installerProcess.Id, 'Close')) {
      # electron-builder's assisted InstFiles page can expose Close after a successful install.
      # Never click a Close button merely because it exists while files are still being written.
      Write-ReinstallLog 'Attempting installer action: Close after verified successful completion.'
      $acted = [ParadigmEveInstallerUi]::ClickButton([uint32]$installerProcess.Id, 'Close')
      if ($acted) { Write-ReinstallLog 'Closed the completed installer.' }
    } elseif ([ParadigmEveInstallerUi]::HasButton([uint32]$installerProcess.Id, 'Install')) {
      Write-ReinstallLog 'Attempting installer action: Install.'
      $acted = [ParadigmEveInstallerUi]::ClickButton([uint32]$installerProcess.Id, 'Install')
      if ($acted) { Write-ReinstallLog 'Committed installation using the default destination/options.' }
    } elseif ([ParadigmEveInstallerUi]::HasButton([uint32]$installerProcess.Id, 'Next')) {
      Write-ReinstallLog 'Attempting installer action: Next.'
      $acted = [ParadigmEveInstallerUi]::ClickButton([uint32]$installerProcess.Id, 'Next')
      if ($acted) { Write-ReinstallLog 'Accepted installer default and advanced to the next page.' }
    } elseif ([ParadigmEveInstallerUi]::HasButton([uint32]$installerProcess.Id, 'Retry') -and @(Get-ParadigmEveProcesses).Count -eq 0) {
      Write-ReinstallLog 'Attempting installer action: Retry.'
      $acted = [ParadigmEveInstallerUi]::ClickButton([uint32]$installerProcess.Id, 'Retry')
      if ($acted) { Write-ReinstallLog 'Retried installer after confirming ParadigmEve is no longer running.' }
    }
    if ($acted) { $actedSnapshot = $snapshot }
  }

  Start-Sleep -Milliseconds 400
}

if ($installerProcess.ExitCode -ne 0) {
  throw "Installer exited with code $($installerProcess.ExitCode)."
}
Write-ReinstallLog 'Installer completed successfully.'

function Resolve-InstalledParadigmEveExe {
  $marker = Join-Path $env:APPDATA 'ParadigmEve\install-path.txt'
  if (Test-Path -LiteralPath $marker -PathType Leaf) {
    $recorded = (Get-Content -LiteralPath $marker -Raw).Trim()
    if (-not $recorded) { throw "ParadigmEve install-path marker is empty: $marker" }
    $candidate = [IO.Path]::GetFullPath($recorded)
    if ([IO.Path]::GetFileName($candidate) -ine 'ParadigmEve.exe') {
      throw "ParadigmEve install-path marker does not name ParadigmEve.exe: $marker"
    }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      throw "ParadigmEve install-path marker points to a missing executable: $candidate"
    }
    return $candidate
  }

  # Backward compatibility for an upgrade from a build that predates install-path.txt.
  $fallback = Join-Path $env:LOCALAPPDATA 'Programs\ParadigmEve\ParadigmEve.exe'
  if (Test-Path -LiteralPath $fallback -PathType Leaf) { return $fallback }
  throw "Installed executable not found and no ParadigmEve install-path marker exists: $marker"
}
$installedExe = Resolve-InstalledParadigmEveExe
Write-ReinstallLog "Resolved installed executable: $installedExe"

function Signal-Recovery([int]$Attempt) {
  Write-ReinstallLog "Recovery attempt ${Attempt}: launching/signalling ParadigmEve visibly with one-shot connect + Companion-browser recovery requests."
  Start-Process -FilePath $installedExe -ArgumentList @('--connect-on-start', '--recover-companion-browser')
}

function Test-RecoveryReady {
  foreach ($port in 8765..8769) {
    try {
      $reply = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/recovery" -TimeoutSec 2
      if ($reply.StatusCode -ne 200) { continue }

      $recovery = $reply.Content | ConvertFrom-Json
      if (
        $recovery.app -eq 'chat-on-steroids' -and
        $recovery.product -eq 'paradigmeve' -and
        $recovery.bridge -eq 15 -and
        $recovery.ready -eq $true
      ) {
        return $true
      }
    } catch {
      # The app may not own this port yet. Continue through the fixed bridge range.
    }
  }
  return $false
}

$attempts = [Math]::Floor($RecoverySeconds / $RetrySeconds) + 1
for ($attempt = 1; $attempt -le $attempts; $attempt++) {
  Signal-Recovery $attempt
  $settleUntil = [DateTimeOffset]::Now.AddSeconds([Math]::Min(10, [Math]::Max(2, $RetrySeconds / 3)))
  do {
    Start-Sleep -Seconds 1
    if (@(Get-ParadigmEveProcesses).Count -gt 0 -and (Test-RecoveryReady)) {
      Write-ReinstallLog 'ParadigmEve and a current-generation Companion ChatGPT document are back. ChatGPT-side tool recovery can now be retried.'
      exit 0
    }
  } while ([DateTimeOffset]::Now -lt $settleUntil)

  if ($attempt -lt $attempts) {
    Write-ReinstallLog "ParadigmEve is not locally ready yet; waiting $RetrySeconds seconds before the next recovery signal."
    Start-Sleep -Seconds $RetrySeconds
  }
}

throw "ParadigmEve did not restore a current-generation Companion ChatGPT document within $RecoverySeconds seconds. See $logFile"
