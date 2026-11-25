#Requires -Version 5.1
<#
.SYNOPSIS
    Installs zk-bridge as a Windows service using NSSM.

.DESCRIPTION
    Run from an elevated PowerShell ("Run as Administrator") after
    `npm install`, creating .env and `npm run build`.
    Running it again replaces the existing service with a fresh one.

.PARAMETER ServiceName
    Windows service name. Default: ZKBridge.

.PARAMETER Nssm
    Path to nssm.exe, or "nssm" if it is on PATH. Default: nssm.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\install-service.ps1

.EXAMPLE
    .\scripts\install-service.ps1 -Nssm C:\tools\nssm\win64\nssm.exe -ServiceName ZKBridge
#>
[CmdletBinding()]
param(
    [string]$ServiceName = 'ZKBridge',
    [string]$Nssm = 'nssm'
)

$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
    Write-Host "ERROR: $Message" -ForegroundColor Red
    exit 1
}

# Runs nssm and stops on a non-zero exit code. (Native commands don't throw in
# Windows PowerShell 5.1, and redirecting their stderr there would, so check
# $LASTEXITCODE instead.)
function Invoke-Nssm {
    & $script:NssmExe @args
    if ($LASTEXITCODE -ne 0) { Fail "nssm $($args -join ' ') failed (exit code $LASTEXITCODE)" }
}

# ---------------------------------------------------------------- checks

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Fail 'Run this script from an elevated PowerShell (right-click PowerShell > Run as Administrator).'
}

$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$EntryJs = Join-Path $ProjectDir 'dist\index.js'
$EnvFile = Join-Path $ProjectDir '.env'
$LogDir = Join-Path $ProjectDir 'logs'
$LogFile = Join-Path $LogDir 'bridge.log'

$nssmCmd = Get-Command $Nssm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $nssmCmd) {
    Fail "nssm not found ('$Nssm'). Download it from https://nssm.cc/download and pass -Nssm C:\path\to\win64\nssm.exe, or add it to PATH."
}
$script:NssmExe = $nssmCmd.Source

$nodeCmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $nodeCmd) { Fail 'node.exe not found on PATH. Install Node.js 22.13 or newer, then open a new PowerShell.' }
$NodeExe = $nodeCmd.Source

if (-not (Test-Path $EntryJs)) { Fail "$EntryJs not found. Run 'npm install' and 'npm run build' in $ProjectDir first." }
if (-not (Test-Path $EnvFile)) { Fail "$EnvFile not found. Copy .env.example to .env and fill it in." }

Write-Host "Project : $ProjectDir"
Write-Host "Node    : $NodeExe ($(& $NodeExe --version))"
Write-Host "NSSM    : $script:NssmExe"
Write-Host ''

# ------------------------------------------------- remove existing service

if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    Write-Host "Removing existing service '$ServiceName'..."
    & $script:NssmExe stop $ServiceName | Out-Null   # fails harmlessly if it is not running
    & $script:NssmExe remove $ServiceName confirm | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "Could not remove the existing service '$ServiceName'. Close services.msc and try again." }
    Start-Sleep -Seconds 2
}

# ---------------------------------------------------------------- install

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

Write-Host "Installing service '$ServiceName'..."
# Relative script path on purpose: AppDirectory is the project folder, and it
# avoids PowerShell 5.1 quoting bugs with paths that contain spaces.
Invoke-Nssm install $ServiceName $NodeExe 'dist\index.js'
Invoke-Nssm set $ServiceName AppDirectory $ProjectDir
Invoke-Nssm set $ServiceName DisplayName 'ZK Bridge (ZKTeco K40 to CRM)'
Invoke-Nssm set $ServiceName Description 'Reads attendance punches from the ZKTeco K40 on the LAN and sends them to the CRM over HTTPS.'
Invoke-Nssm set $ServiceName Start SERVICE_AUTO_START

# stdout + stderr into one log file, appended (4 = OPEN_ALWAYS), rotated at 10 MB while running.
Invoke-Nssm set $ServiceName AppStdout $LogFile
Invoke-Nssm set $ServiceName AppStderr $LogFile
Invoke-Nssm set $ServiceName AppStdoutCreationDisposition 4
Invoke-Nssm set $ServiceName AppStderrCreationDisposition 4
Invoke-Nssm set $ServiceName AppRotateFiles 1
Invoke-Nssm set $ServiceName AppRotateOnline 1
Invoke-Nssm set $ServiceName AppRotateBytes 10485760

# Restart 5 s after any exit. On stop, send Ctrl+C (Node sees SIGINT) and give
# the bridge 10 s to flush and close the database before NSSM escalates.
Invoke-Nssm set $ServiceName AppExit Default Restart
Invoke-Nssm set $ServiceName AppRestartDelay 5000
Invoke-Nssm set $ServiceName AppStopMethodConsole 10000

Write-Host "Starting service '$ServiceName'..."
Invoke-Nssm start $ServiceName
Start-Sleep -Seconds 3
& $script:NssmExe status $ServiceName

Write-Host ''
Write-Host 'Done. Manage the service with:' -ForegroundColor Green
Write-Host "  nssm status  $ServiceName"
Write-Host "  nssm restart $ServiceName"
Write-Host "  nssm stop    $ServiceName"
Write-Host "  nssm start   $ServiceName"
Write-Host "  nssm edit    $ServiceName          (settings window)"
Write-Host "  nssm remove  $ServiceName confirm  (uninstall)"
Write-Host ''
Write-Host 'Follow the log with:'
Write-Host "  Get-Content '$LogFile' -Tail 50 -Wait"
