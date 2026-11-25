# OpenBot fork launcher for Windows (the Windows twin of scripts/fork/app.sh).
#
# Every click: when the fork's main has a newer Windows build than the one installed, download it
# (GitHub builds it on each push: .github/workflows/fork-windows.yml), swap it in, then open
# OpenBot. A running OpenBot is never replaced: the click just brings it forward. No network or a
# failed download opens the installed copy.
#
# Install: irm https://raw.githubusercontent.com/eliasx45/openbot/main/scripts/fork/windows/install.ps1 | iex
#   -Install     first run: also makes the Start menu and desktop shortcuts (taskbar-pinnable)
#   -NoLaunch    update only, do not open OpenBot (CI)
#   -Quiet       no window (CI)
#   -Source <p>  a folder or URL holding commit.txt, OpenBot-fork-win-x64.zip and launcher.ps1
#
# Windows PowerShell 5.1 compatible (no ?:, no ??): it is what every Windows 10/11 has.
param(
    [switch]$Install,
    [switch]$NoLaunch,
    [switch]$Quiet,
    [string]$Source = "https://github.com/eliasx45/openbot/releases/download/fork-windows"
)
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = Join-Path $env:LOCALAPPDATA "OpenBotFork"
$App = Join-Path $Root "app"
$Exe = Join-Path $App "OpenBot.exe"
$Stamp = Join-Path $Root "installed-commit"
$Log = Join-Path $Root "launcher.log"
$ZipName = "OpenBot-fork-win-x64.zip"
# The id OpenBot gives its windows (src/main/index.ts setAppUserModelId): a shortcut with the
# same id shares one taskbar button with the running app.
$Aumid = "app.openbot.desktop"
New-Item -ItemType Directory -Force -Path $Root | Out-Null

function Write-Log([string]$Text) {
    Add-Content -LiteralPath $Log -Value ("{0:yyyy-MM-dd HH:mm:ss} {1}" -f (Get-Date), $Text)
}

$IsLocalSource = -not ($Source -match '^https?://')
Add-Type -AssemblyName System.Net.Http
$Http = New-Object System.Net.Http.HttpClient
$Http.Timeout = [TimeSpan]::FromMinutes(60)

function Get-SourceText([string]$Name) {
    if ($IsLocalSource) { return (Get-Content -Raw -LiteralPath (Join-Path $Source $Name)) }
    $short = New-Object System.Net.Http.HttpClient
    $short.Timeout = [TimeSpan]::FromSeconds(15)
    try { return $short.GetStringAsync("$Source/$Name").GetAwaiter().GetResult() } finally { $short.Dispose() }
}

function Test-Running {
    $procs = Get-Process -Name OpenBot -ErrorAction SilentlyContinue | Where-Object {
        try { $_.Path -and $_.Path.StartsWith($App, [StringComparison]::OrdinalIgnoreCase) } catch { $false }
    }
    return [bool]$procs
}

function Open-OpenBot {
    if ($NoLaunch) { return }
    if (-not (Test-Path -LiteralPath $Exe)) { throw "OpenBot is not installed yet ($Exe)." }
    Start-Process -FilePath $Exe -WorkingDirectory $App
}

# --- progress window -------------------------------------------------------------------------
$script:Form = $null
$script:Skip = $false
function Show-Progress([string]$Text) {
    if ($Quiet) { return }
    if (-not $script:Form) {
        Add-Type -AssemblyName System.Windows.Forms, System.Drawing
        [System.Windows.Forms.Application]::EnableVisualStyles()
        $f = New-Object System.Windows.Forms.Form
        $f.Text = "OpenBot"
        $f.ClientSize = New-Object System.Drawing.Size(440, 120)
        $f.StartPosition = "CenterScreen"
        $f.FormBorderStyle = "FixedDialog"
        $f.MaximizeBox = $false
        $f.MinimizeBox = $false
        $f.TopMost = $true
        if (Test-Path -LiteralPath $Exe) {
            try { $f.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($Exe) } catch {}
        }
        $l = New-Object System.Windows.Forms.Label
        $l.Name = "status"
        $l.SetBounds(16, 14, 408, 22)
        $l.Font = New-Object System.Drawing.Font("Segoe UI", 10)
        $b = New-Object System.Windows.Forms.ProgressBar
        $b.Name = "bar"
        $b.SetBounds(16, 44, 408, 18)
        $s = New-Object System.Windows.Forms.Button
        $s.Text = "Open without updating"
        $s.SetBounds(264, 78, 160, 28)
        $s.add_Click({ $script:Skip = $true })
        $f.Controls.AddRange(@($l, $b, $s))
        $f.add_FormClosing({ $script:Skip = $true })
        $f.Show()
        $script:Form = $f
    }
    $script:Form.Controls["status"].Text = $Text
    [System.Windows.Forms.Application]::DoEvents()
}
function Set-Progress([int]$Percent) {
    if (-not $script:Form) { return }
    $script:Form.Controls["bar"].Value = [Math]::Max(0, [Math]::Min(100, $Percent))
    [System.Windows.Forms.Application]::DoEvents()
}
function Close-Progress {
    if ($script:Form) { $script:Form.Hide(); $script:Form.Dispose(); $script:Form = $null }
}

# --- download --------------------------------------------------------------------------------
# Returns $false when the user chose "Open without updating".
function Get-SourceFile([string]$Name, [string]$Target) {
    if ($IsLocalSource) { Copy-Item -LiteralPath (Join-Path $Source $Name) -Destination $Target -Force; return $true }
    $response = $Http.GetAsync("$Source/$Name", [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    if (-not $response.IsSuccessStatusCode) { throw "Download of $Name failed: HTTP $([int]$response.StatusCode)" }
    $total = $response.Content.Headers.ContentLength
    $in = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $out = [System.IO.File]::Create($Target)
    try {
        $buffer = New-Object byte[] (1024 * 1024)
        $done = 0L
        while (($n = $in.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $out.Write($buffer, 0, $n)
            $done += $n
            if ($total) {
                Set-Progress ([int](100 * $done / $total))
                if ($script:Form) {
                    $script:Form.Controls["status"].Text = ("Updating OpenBot from Elias's main: {0:N0} of {1:N0} MB" -f ($done / 1MB), ($total / 1MB))
                }
            }
            if ($script:Skip) { return $false }
        }
    } finally { $out.Dispose(); $in.Dispose(); $response.Dispose() }
    return $true
}

# --- shortcuts -------------------------------------------------------------------------------
# A .lnk carries the AppUserModelID through IPropertyStore; WScript.Shell cannot set it.
$ShortcutCode = @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public static class OpenBotForkShortcut {
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")] class CShellLink {}
    [StructLayout(LayoutKind.Sequential, Pack = 4)] struct PropertyKey { public Guid fmtid; public uint pid; }
    [StructLayout(LayoutKind.Explicit, Size = 24)] struct PropVariant { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; }
    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    interface IPropertyStore {
        void GetCount(out uint count);
        void GetAt(uint index, out PropertyKey key);
        void GetValue(ref PropertyKey key, out PropVariant value);
        void SetValue(ref PropertyKey key, ref PropVariant value);
        void Commit();
    }
    static PropertyKey AumidKey() { var k = new PropertyKey(); k.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"); k.pid = 5; return k; }
    public static void SetAppId(string path, string appId) {
        var link = new CShellLink();
        ((IPersistFile)link).Load(path, 2);
        var key = AumidKey();
        var value = new PropVariant(); value.vt = 31; value.p = Marshal.StringToCoTaskMemUni(appId);
        try { ((IPropertyStore)link).SetValue(ref key, ref value); ((IPropertyStore)link).Commit(); }
        finally { Marshal.FreeCoTaskMem(value.p); }
        ((IPersistFile)link).Save(path, true);
        Marshal.ReleaseComObject(link);
    }
    public static string GetAppId(string path) {
        var link = new CShellLink();
        ((IPersistFile)link).Load(path, 0);
        var key = AumidKey();
        PropVariant value;
        ((IPropertyStore)link).GetValue(ref key, out value);
        string result = value.vt == 31 ? Marshal.PtrToStringUni(value.p) : null;
        Marshal.ReleaseComObject(link);
        return result;
    }
}
'@

function New-LauncherShortcut([string]$Path) {
    if (-not ("OpenBotForkShortcut" -as [type])) { Add-Type -TypeDefinition $ShortcutCode }
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($Path)
    $lnk.TargetPath = Join-Path $PSHOME "powershell.exe"
    $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $Root 'launcher.ps1')`""
    $lnk.WorkingDirectory = $Root
    $lnk.IconLocation = "$Exe,0"
    $lnk.Description = "OpenBot (Elias's fork): updates from his main, then opens"
    $lnk.WindowStyle = 7
    $lnk.Save()
    [OpenBotForkShortcut]::SetAppId($Path, $Aumid)
    Write-Log "shortcut $Path (app id $([OpenBotForkShortcut]::GetAppId($Path)))"
}

function Install-Shortcuts {
    $startMenu = Join-Path ([Environment]::GetFolderPath("Programs")) "OpenBot.lnk"
    New-LauncherShortcut $startMenu
    New-LauncherShortcut (Join-Path ([Environment]::GetFolderPath("Desktop")) "OpenBot.lnk")
}

# The first install: keep a copy of an existing OpenBot database (official release) for a rollback.
function Backup-ExistingData {
    if (Test-Path -LiteralPath $Stamp) { return }
    $data = Join-Path $env:APPDATA "OpenBot"
    if (-not (Test-Path -LiteralPath (Join-Path $data "openbot.db"))) { return }
    $backup = Join-Path $Root ("backup-{0:yyyyMMdd-HHmmss}" -f (Get-Date))
    New-Item -ItemType Directory -Force -Path $backup | Out-Null
    Get-ChildItem -LiteralPath $data -Filter "openbot.db*" | Copy-Item -Destination $backup
    Write-Log "backed up the existing OpenBot database to $backup"
}

# --- main ------------------------------------------------------------------------------------
try {
    if (Test-Running) {
        Write-Log "OpenBot is already running: bring it forward"
        Open-OpenBot
        exit 0
    }
    $installed = ""
    if ((Test-Path -LiteralPath $Stamp) -and (Test-Path -LiteralPath $Exe)) { $installed = (Get-Content -Raw -LiteralPath $Stamp).Trim() }
    $latest = ""
    try { $latest = (Get-SourceText "commit.txt").Trim() } catch { Write-Log "no update check: $($_.Exception.Message)" }

    if ($latest -and $latest -ne $installed) {
        Write-Log "updating $installed -> $latest"
        Show-Progress "Updating OpenBot from Elias's main..."
        $zip = Join-Path $Root "download.zip"
        $finished = Get-SourceFile $ZipName $zip
        if ($finished) {
            Show-Progress "Installing..."
            Backup-ExistingData
            $new = Join-Path $Root "app-new"
            $old = Join-Path $Root "app-old"
            foreach ($dir in @($new, $old)) { if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force } }
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $new)
            if (-not (Test-Path -LiteralPath (Join-Path $new "OpenBot.exe"))) { throw "The download has no OpenBot.exe." }
            if (Test-Running) { throw "OpenBot was opened during the update: quit it and click again." }
            if (Test-Path -LiteralPath $App) { Rename-Item -LiteralPath $App -NewName "app-old" }
            Rename-Item -LiteralPath $new -NewName "app"
            Set-Content -LiteralPath $Stamp -Value $latest -NoNewline
            Remove-Item -LiteralPath $zip -Force
            if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue }
            # The launcher of the same build replaces this one for the next click.
            try { Get-SourceFile "launcher.ps1" (Join-Path $Root "launcher.ps1.new") | Out-Null; Move-Item -Force (Join-Path $Root "launcher.ps1.new") (Join-Path $Root "launcher.ps1") } catch { Write-Log "launcher not refreshed: $($_.Exception.Message)" }
            Write-Log "installed $latest"
        } else {
            Write-Log "update skipped by the user"
        }
        Close-Progress
    }
    if ($Install) { Install-Shortcuts }
    Open-OpenBot
    exit 0
} catch {
    Close-Progress
    Write-Log "failed: $($_.Exception.Message)"
    if (Test-Path -LiteralPath $Exe) {
        Open-OpenBot
        if ($Quiet) { exit 1 }
        exit 0
    }
    if (-not $Quiet) {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show("OpenBot could not be installed: $($_.Exception.Message)`n`nLog: $Log", "OpenBot") | Out-Null
    } else {
        Write-Error $_.Exception.Message
    }
    exit 1
}
