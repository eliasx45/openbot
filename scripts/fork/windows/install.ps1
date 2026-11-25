# One-time setup of Elias's OpenBot fork on a Windows PC. Run in PowerShell (no admin needed):
#   irm https://raw.githubusercontent.com/eliasx45/openbot/main/scripts/fork/windows/install.ps1 | iex
# It puts the launcher in %LOCALAPPDATA%\OpenBotFork, downloads the newest build of the fork's main,
# makes "OpenBot" shortcuts (Start menu, desktop) and opens OpenBot. Then: right-click the Start
# menu entry > Pin to taskbar. Every click on it updates from the fork's main first.
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = Join-Path $env:LOCALAPPDATA "OpenBotFork"
New-Item -ItemType Directory -Force -Path $root | Out-Null
$launcher = Join-Path $root "launcher.ps1"
Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/eliasx45/openbot/releases/download/fork-windows/launcher.ps1" -OutFile $launcher
$official = Join-Path $env:LOCALAPPDATA "Programs\OpenBot\OpenBot.exe"
if (Test-Path -LiteralPath $official) {
    Write-Host "Note: the official OpenBot is installed too. Both use the same data; open only the fork from now on (uninstalling the official one keeps the data)."
}
Write-Host "Downloading OpenBot (Elias's fork). A progress window opens..."
& (Join-Path $PSHOME "powershell.exe") -NoProfile -ExecutionPolicy Bypass -File $launcher -Install
if ($LASTEXITCODE -eq 0) {
    Write-Host "Done. Right-click 'OpenBot' in the Start menu > Pin to taskbar."
} else {
    Write-Host "Setup failed. Log: $(Join-Path $root 'launcher.log')"
}
