#Requires -Version 5.1
<#
  zk-bridge setup for Windows: one command to install the bridge and run it as a
  Windows service. Usually started through setup.cmd (double-click it, or run it in
  PowerShell / Command Prompt):

    setup.cmd               interactive: Node.js -> packages -> settings -> K40 check -> service -> check
    setup.cmd --yes         the same without questions (uses .env as it is)
    setup.cmd status|logs|start|stop|restart|test|info|update|uninstall|help

  Steps that change the system ask for Administrator rights once (UAC prompt) and
  continue in a new Administrator window.

  Keep this file ASCII only: Windows PowerShell 5.1 misreads UTF-8 files without a BOM.
#>

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$ScriptArgs = @($args)
$Root = $PSScriptRoot
$Helper = Join-Path $Root 'scripts\setup-helper.js'
$EnvFile = Join-Path $Root '.env'
$LogFile = Join-Path $Root 'logs\bridge.log'
$ServiceName = 'ZKBridge'
$ReadyTimeoutSec = 180
$BasicKeys = @('DEVICE_IP', 'DEVICE_PORT', 'DEVICE_TIMEZONE', 'CRM_BASE_URL', 'CRM_DEVICE_KEY')

# NSSM 2.24-101 (the pre-release recommended in WINDOWS-SETUP.md; same file and hash as winget's NSSM.NSSM).
$NssmDir = 'C:\tools\nssm\win64'
$NssmUrl = 'https://nssm.cc/ci/nssm-2.24-101-g897c7ad.zip'
$NssmSha256 = '99F5045FFFBFFB745D67FE3A065A953C4A3D9C253B868892D9B685B0EE7D07B8'
$NssmZipPath = 'nssm-2.24-101-g897c7ad\win64\nssm.exe'

$script:AssumeYes = $false
$script:Elevated = $false
$script:Values = [ordered]@{}

# ---------------------------------------------------------------- output and questions

function Say([string]$Text = '') { Write-Host $Text }
function Info([string]$Text) { Write-Host '==> ' -ForegroundColor Cyan -NoNewline; Write-Host $Text }
function Ok([string]$Text) { Write-Host ' ok ' -ForegroundColor Green -NoNewline; Write-Host $Text }
function Warn([string]$Text) { Write-Host ' !  ' -ForegroundColor Yellow -NoNewline; Write-Host $Text }
function Fail([string]$Text) { throw $Text }

function Ask([string]$Question, [string]$Default) {
    if ($script:AssumeYes) { return $Default }
    $answer = Read-Host "$Question [$Default]"
    if ($null -eq $answer) { $answer = '' }
    $answer = $answer.Trim()
    if ($answer -eq '') { return $Default }
    return $answer
}

function Get-Masked([string]$Value) {
    if ([string]::IsNullOrEmpty($Value)) { return '(empty)' }
    if ($Value -eq 'replace-me') { return 'replace-me (not set yet)' }
    if ($Value.Length -le 8) { return '****' }
    return $Value.Substring(0, 4) + '...' + $Value.Substring($Value.Length - 2)
}

function Ask-Secret([string]$Question, [string]$Current) {
    if ($script:AssumeYes) { return $Current }
    $secure = Read-Host "$Question [$(Get-Masked $Current)]" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    if ($null -eq $plain) { $plain = '' }
    $plain = $plain.Trim()
    if ($plain -eq '') { return $Current }
    return $plain
}

function Confirm-Step([string]$Question, [bool]$DefaultYes) {
    if ($script:AssumeYes) { return $DefaultYes }
    $hint = if ($DefaultYes) { '[Y/n]' } else { '[y/N]' }
    $answer = Read-Host "$Question $hint"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $DefaultYes }
    return ($answer.Trim() -match '^[Yy]')
}

function Get-Label([string]$Key) {
    switch ($Key) {
        'DEVICE_IP' { return 'K40 IP address (DEVICE_IP)' }
        'DEVICE_PORT' { return 'K40 port (DEVICE_PORT)' }
        'DEVICE_TIMEZONE' { return 'Timezone of the K40 clock (DEVICE_TIMEZONE)' }
        'CRM_BASE_URL' { return 'CRM API address, https://... (CRM_BASE_URL)' }
        'CRM_DEVICE_KEY' { return 'Device key from the CRM (CRM_DEVICE_KEY)' }
        default { return $Key }
    }
}

# ---------------------------------------------------------------- system checks

function Test-Admin {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Re-runs this script in an Administrator window (one UAC prompt) and waits for it.
function Invoke-Elevated {
    if ($script:Elevated) { Fail 'Could not get Administrator rights.' }
    Info 'Asking for Administrator rights (needed to install Node.js and the Windows service)...'
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $PSCommandPath))
    foreach ($a in $ScriptArgs) { $argList += ('"{0}"' -f $a) }
    $argList += '--elevated'
    try {
        $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argList -PassThru -Wait
    } catch {
        Fail 'Administrator rights were refused. Run setup.cmd again and click Yes, or right-click PowerShell > Run as administrator.'
    }
    if ($p.ExitCode -eq 0) { Ok 'Done (see the Administrator window for details).' }
    else { Warn "The Administrator window reported a problem (exit code $($p.ExitCode))." }
    exit $p.ExitCode
}

function Test-Folder {
    $bad = @(
        [Environment]::GetFolderPath('Desktop'),
        [Environment]::GetFolderPath('MyDocuments'),
        (Join-Path $env:USERPROFILE 'Downloads'),
        $env:OneDrive, $env:OneDriveCommercial, $env:OneDriveConsumer
    ) | Where-Object { $_ }
    $here = $Root.TrimEnd('\') + '\'
    $hit = $bad | Where-Object { $here.StartsWith($_.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1
    if (-not $hit -and $here -notmatch '\\OneDrive') { return }
    Warn 'This folder is on the Desktop, in Documents or Downloads, or under OneDrive:'
    Warn "  $Root"
    Warn 'Synced folders can damage the bridge database, and the service runs as a system account.'
    Warn 'Move the folder to C:\zk-bridge and run setup.cmd from there.'
    if (-not (Confirm-Step 'Continue here anyway?' $false)) { exit 1 }
}

function Update-PathFromRegistry {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

function Get-NodeExe {
    $cmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    return $null
}

function Test-NodeOk {
    if (-not (Get-NodeExe)) { return $false }
    # 'Continue' here: in PowerShell 5.1, redirecting a native command's stderr throws under 'Stop'.
    $ErrorActionPreference = 'Continue'
    & node $Helper node-ok 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
}

function Enable-Tls12 {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
}

function Install-NodeMsi {
    Enable-Tls12
    Info 'Downloading the Node.js LTS installer from nodejs.org'
    $index = Invoke-RestMethod -UseBasicParsing -Uri 'https://nodejs.org/dist/index.json'
    $lts = $null
    foreach ($v in $index) { if ($v.lts) { $lts = $v; break } }   # newest first; lts is false or a codename
    if (-not $lts) { Fail 'Could not find the current Node.js LTS version on nodejs.org.' }
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    $name = "node-$($lts.version)-$arch.msi"
    $base = "https://nodejs.org/dist/$($lts.version)"
    $msi = Join-Path $env:TEMP $name
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$name" -OutFile $msi
    $sums = [string](Invoke-WebRequest -UseBasicParsing -Uri "$base/SHASUMS256.txt").Content
    $expected = $null
    foreach ($line in ($sums -split "`n")) {
        $parts = $line.Trim() -split '\s+'
        if ($parts.Count -eq 2 -and $parts[1] -eq $name) { $expected = $parts[0] }
    }
    $actual = (Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash
    if (-not $expected -or $actual -ne $expected.ToUpperInvariant()) {
        Remove-Item -LiteralPath $msi -Force -ErrorAction SilentlyContinue
        Fail "The downloaded $name doesn't match its checksum. Try again, or install Node.js LTS from https://nodejs.org by hand."
    }
    Info "Installing Node.js $($lts.version) (silent)"
    $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', ('"{0}"' -f $msi), '/qn', '/norestart') -Wait -PassThru
    Remove-Item -LiteralPath $msi -Force -ErrorAction SilentlyContinue
    if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { Fail "The Node.js installer failed (exit code $($p.ExitCode))." }
}

function Install-Node {
    $hadNode = [bool](Get-NodeExe)
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $hadNode -and $winget) {
        Info 'Installing Node.js LTS with winget'
        & winget install --id OpenJS.NodeJS.LTS --exact --source winget --silent --accept-package-agreements --accept-source-agreements
        $code = $LASTEXITCODE
        Update-PathFromRegistry
        if (Test-NodeOk) { return }
        Warn "winget didn't give a usable Node.js (exit code $code). Using the installer from nodejs.org instead."
    }
    Install-NodeMsi
    Update-PathFromRegistry
}

function Initialize-Node {
    if (Test-NodeOk) { Ok "Node.js $(& node -v)"; return }
    if (Get-NodeExe) { Warn "Node.js $(& node -v) is too old: zk-bridge needs 22.13 or newer." }
    else { Warn 'Node.js is not installed.' }
    $saved = $script:AssumeYes
    if (-not [Console]::IsInputRedirected) { $script:AssumeYes = $false }   # installing software asks when someone is there
    if (-not (Confirm-Step 'Install Node.js LTS now?' $true)) {
        Fail 'Install Node.js LTS from https://nodejs.org, then run setup.cmd again.'
    }
    $script:AssumeYes = $saved
    Install-Node
    if (-not (Test-NodeOk)) {
        Fail 'Node.js was installed, but this window still finds an old or no node.exe. Close all PowerShell windows, then run setup.cmd again.'
    }
    Ok "Node.js $(& node -v)"
}

# ---------------------------------------------------------------- packages, build, settings

function Invoke-Npm([string[]]$NpmArgs, [string]$What) {
    & npm @NpmArgs
    if ($LASTEXITCODE -ne 0) { Fail "$What failed (exit code $LASTEXITCODE)." }
}

function Install-Packages {
    Info 'Installing packages (npm ci)'
    Invoke-Npm @('ci', '--include=dev', '--no-audit', '--no-fund') 'npm ci'
    Ok 'Packages installed'
}

function Build-Bridge {
    Info 'Building (npm run build)'
    Invoke-Npm @('run', '--silent', 'build') 'The build'
    Ok 'Built dist\'
}

function Read-Settings {
    $lines = @(& node $Helper env-show)
    if ($LASTEXITCODE -ne 0) { Fail 'Could not read .env.example / .env' }
    $script:Values = [ordered]@{}
    foreach ($line in $lines) {
        if ($line -match '^([A-Z_][A-Z0-9_]*)=(.*)$') { $script:Values[$Matches[1]] = $Matches[2] }
    }
}

# Hands the values to the helper. An empty value can't be an environment variable on Windows,
# so it is removed instead; ZKSET__ALL=1 tells the helper that "missing" means "empty".
function Set-SettingsEnv {
    $env:ZKSET__ALL = '1'
    foreach ($k in $script:Values.Keys) {
        $v = [string]$script:Values[$k]
        if ($v -eq '') { Remove-Item -Path "Env:ZKSET_$k" -ErrorAction SilentlyContinue }
        else { Set-Item -Path "Env:ZKSET_$k" -Value $v }
    }
}

# Returns the problems (empty array = valid). With -Key, only the problems of that setting.
function Get-SettingProblems([string]$Key = '') {
    Set-SettingsEnv
    if ($Key) { $out = @(& node $Helper validate $Key) } else { $out = @(& node $Helper validate) }
    if ($LASTEXITCODE -eq 0) { return @() }
    $list = @($out | Where-Object { $_ })
    if ($list.Count -eq 0) { $list = @("Could not check the settings (exit code $LASTEXITCODE)") }
    return $list
}

function Read-Setting([string]$Key) {
    while ($true) {
        if ($Key -eq 'CRM_DEVICE_KEY') { $answer = Ask-Secret "  $(Get-Label $Key)" ([string]$script:Values[$Key]) }
        else { $answer = Ask "  $(Get-Label $Key)" ([string]$script:Values[$Key]) }
        if ($answer.Contains("'") -and $answer.Contains('"')) { Warn 'Use only one kind of quote in a value.'; continue }
        $script:Values[$Key] = $answer
        $problems = @(Get-SettingProblems $Key)
        if ($problems.Count -eq 0) { return }
        foreach ($p in $problems) { Warn $p }
    }
}

function Read-AllSettings([bool]$Advanced) {
    Say ''
    Say 'Settings  (Enter keeps the value in brackets)'
    foreach ($k in $BasicKeys) { Read-Setting $k }
    if ($Advanced -or (Confirm-Step 'Change advanced settings too (intervals, timeouts, log level)?' $false)) {
        foreach ($k in @($script:Values.Keys)) { if ($BasicKeys -notcontains $k) { Read-Setting $k } }
    }
}

function Save-Settings {
    Set-SettingsEnv
    $result = (& node $Helper env-write | Select-Object -Last 1)
    if ($LASTEXITCODE -ne 0) { Fail 'Could not write .env' }
    switch ($result) {
        'unchanged' { Ok 'Settings unchanged (.env)' }
        'created' { Ok 'Saved settings to .env' }
        default { Ok 'Saved settings to .env (the previous one is in .env.bak)' }
    }
}

function Invoke-SettingsStep {
    Read-Settings
    if ($script:AssumeYes) {
        $problems = @(Get-SettingProblems)
        if ($problems.Count -gt 0) {
            foreach ($p in $problems) { Warn $p }
            Fail 'The settings in .env have problems (above). Fix .env, or run setup.cmd without --yes.'
        }
        Ok 'Settings in .env are valid'
        return
    }
    $advanced = $false
    for ($try = 1; ; $try++) {
        Read-AllSettings $advanced
        $problems = @(Get-SettingProblems)
        if ($problems.Count -eq 0) { break }
        foreach ($p in $problems) { Warn $p }
        if ($try -ge 3) { Fail 'The settings still have problems (above). Fix .env by hand, then run setup.cmd --yes' }
        Warn "Some settings have problems (above). Let's go through them again."
        $advanced = $true
    }
    Save-Settings
}

# ---------------------------------------------------------------- K40 checks

function Get-DevicePort { $p = [string]$script:Values['DEVICE_PORT']; if ($p) { return $p } else { return '4370' } }

function Show-DeviceChecklist {
    Say '   Things to check:'
    Say '     - DEVICE_IP / DEVICE_PORT match the K40 (Menu > Comm. > Ethernet)'
    Say '     - this laptop is on the same network as the K40 (the office Wi-Fi, not a guest network)'
    Say "     - the K40 answers a ping: ping $($script:Values['DEVICE_IP'])"
    Say '     - Comm Key on the K40 is 0'
    Say '     - no other program (ZKTime, ZKBioTime...) is connected to the K40 right now'
}

function Test-Device {
    $ip = [string]$script:Values['DEVICE_IP']
    $port = Get-DevicePort
    Info "Checking the K40 at ${ip}:$port"
    $reason = (@(& node $Helper tcp $ip $port) -join ' ')
    if ($LASTEXITCODE -eq 0) { Ok "The K40 answers on ${ip}:$port"; return $true }
    Warn "Could not reach the K40 at ${ip}:${port}: $reason"
    Show-DeviceChecklist
    if (-not (Confirm-Step 'Continue anyway? The bridge keeps retrying until the K40 answers' $true)) {
        Fail 'Stopped. Fix the connection, then run setup.cmd again.'
    }
    return $false
}

# Runs src\poc.ts (built as dist\poc.js) until Enter is pressed.
function Invoke-DeviceTest {
    Info 'Device test: stats, users and latest logs, then live punches (punch a finger to see one)'
    Say '   Press Enter to end the test.'
    $p = Start-Process -FilePath (Get-NodeExe) -ArgumentList 'dist\poc.js' -WorkingDirectory $Root -NoNewWindow -PassThru
    try { [void](Read-Host) }
    finally { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } }
    Ok 'Device test finished'
}

# ---------------------------------------------------------------- service (NSSM)

function Get-BridgeService { return (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) }

function Find-Nssm {
    $cmd = Get-Command nssm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    $exe = Join-Path $NssmDir 'nssm.exe'
    if (Test-Path -LiteralPath $exe) { return $exe }
    return $null
}

function Get-Nssm {
    $found = Find-Nssm
    if ($found) { return $found }
    Enable-Tls12
    Info "Downloading NSSM (runs the bridge as a Windows service) to $NssmDir"
    $zip = Join-Path $env:TEMP 'nssm-2.24-101-g897c7ad.zip'
    $tmp = Join-Path $env:TEMP ('nssm-' + [guid]::NewGuid().ToString('N'))
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $NssmUrl -OutFile $zip
    } catch {
        Fail "Could not download NSSM from $NssmUrl ($($_.Exception.Message)). Download it by hand (WINDOWS-SETUP.md step 9a) so that $NssmDir\nssm.exe exists, then run setup.cmd again."
    }
    try {
        $hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
        if ($hash -ne $NssmSha256) { Fail "The downloaded NSSM doesn't match its checksum ($hash). Not using it." }
        Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
        New-Item -ItemType Directory -Force -Path $NssmDir | Out-Null
        Copy-Item -LiteralPath (Join-Path $tmp $NssmZipPath) -Destination (Join-Path $NssmDir 'nssm.exe') -Force
    } finally {
        Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
    $exe = Join-Path $NssmDir 'nssm.exe'
    Ok "NSSM installed: $exe"
    return $exe
}

function Install-BridgeService {
    $nssm = Get-Nssm
    Info "Installing the Windows service '$ServiceName'"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'scripts\install-service.ps1') -Nssm $nssm -ServiceName $ServiceName
    if ($LASTEXITCODE -ne 0) { Fail "Installing the service failed (exit code $LASTEXITCODE, see above)." }
    $svc = Get-BridgeService
    if (-not $svc) { Fail "The service '$ServiceName' was not created (see above)." }
    Ok "Service '$ServiceName' installed (starts at boot without login, restarts after a crash)"
}

function Stop-BridgeService {
    $svc = Get-BridgeService
    if ($svc -and $svc.Status -ne 'Stopped') { Stop-Service -Name $ServiceName }
}

function Start-BridgeService {
    if (-not (Get-BridgeService)) { Fail "The service isn't installed yet. Run setup.cmd first." }
    Start-Service -Name $ServiceName
}

function Uninstall-BridgeService {
    if (-not (Get-BridgeService)) { Ok "The service isn't installed"; return }
    Info "Removing the service '$ServiceName'"
    $nssm = Find-Nssm
    if ($nssm) {
        & $nssm stop $ServiceName | Out-Null
        & $nssm remove $ServiceName confirm
    } else {
        Stop-Service -Name $ServiceName -ErrorAction SilentlyContinue
        & sc.exe delete $ServiceName | Out-Null
    }
    if ($LASTEXITCODE -ne 0) { Fail "Could not remove the service (exit code $LASTEXITCODE). Close services.msc and try again." }
    Ok 'Service removed. Your settings (.env), queued punches (data\) and logs are kept.'
}

# ---------------------------------------------------------------- log

function Get-LogMark {
    if (Test-Path -LiteralPath $LogFile) { return [long](Get-Item -LiteralPath $LogFile).Length }
    return [long]0
}

# Log text written after $Offset. NSSM keeps the file open, so open it shared.
function Read-LogSince([long]$Offset) {
    if (-not (Test-Path -LiteralPath $LogFile)) { return '' }
    $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
    $fs = [IO.File]::Open($LogFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
    try {
        if ($fs.Length -lt $Offset) { $Offset = 0 }   # rotated meanwhile
        [void]$fs.Seek($Offset, [IO.SeekOrigin]::Begin)
        $reader = New-Object IO.StreamReader($fs)
        return $reader.ReadToEnd()
    } finally { $fs.Dispose() }
}

function Show-LastLines([string]$Text) {
    $lines = @($Text -split "`r?`n" | Where-Object { $_ })
    $lines | Select-Object -Last 25 | ForEach-Object { Write-Host "      $_" }
}

function Wait-Ready([long]$Mark) {
    Info 'Waiting for the bridge to start (it first downloads the K40 log)'
    $deadline = (Get-Date).AddSeconds($ReadyTimeoutSec)
    while ($true) {
        $text = Read-LogSince $Mark
        if ($text -match 'Bridge running') { Ok 'Bridge running'; return $true }
        if ($text -match 'Invalid configuration|Could not load configuration|Fatal:|refusing to start') {
            Warn 'The bridge failed to start. Last log lines:'
            Show-LastLines $text
            return $false
        }
        if ((Get-Date) -gt $deadline) {
            Warn "No 'Bridge running' after $ReadyTimeoutSec s. Last log lines:"
            Show-LastLines $text
            return $false
        }
        Start-Sleep -Seconds 2
    }
}

function Get-LastStatusLine {
    $lines = @((Read-LogSince 0) -split "`r?`n" | Where-Object { $_.Contains('Status:') })
    if ($lines.Count -gt 0) { return $lines[$lines.Count - 1] }
    return $null
}

# ---------------------------------------------------------------- laptop power settings

function Set-LaptopPower {
    Say ''
    Say 'Laptop power settings (WINDOWS-SETUP.md step 10): never sleep or hibernate,'
    Say 'closing the lid does nothing, Wi-Fi adapter at full power. The screen can still turn off.'
    if (-not (Confirm-Step 'Apply these power settings now?' $true)) { Warn 'Skipped. See WINDOWS-SETUP.md step 10 to do it later.'; return }
    $failed = 0
    $wifi = '19cbb8fa-5279-450e-9fac-8a3d5fedd0c1 12bbebe6-58d6-4636-95bb-3217ef867c1a'
    $commands = @(
        '/change standby-timeout-ac 0', '/change hibernate-timeout-ac 0',
        '/change standby-timeout-dc 0', '/change hibernate-timeout-dc 0',
        '/setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0',
        '/setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0',
        "/setacvalueindex SCHEME_CURRENT $wifi 0",
        "/setdcvalueindex SCHEME_CURRENT $wifi 0",
        '/setactive SCHEME_CURRENT'
    )
    foreach ($c in $commands) {
        & powercfg.exe @($c -split ' ') | Out-Null
        if ($LASTEXITCODE -ne 0) {
            $failed++
            if ($c -like "*$wifi*") { Warn 'Wi-Fi power setting not available here: set it by hand if you can (WINDOWS-SETUP.md step 10.2).' }
            else { Warn "powercfg $c failed (exit code $LASTEXITCODE)" }
        }
    }
    if ($failed -eq 0) { Ok 'Power settings applied' } else { Ok 'Power settings applied (except the ones above)' }
    Say '   Also once by hand: Device Manager > Network adapters > your Wi-Fi adapter > Power Management >'
    Say '   untick "Allow the computer to turn off this device to save power" (WINDOWS-SETUP.md step 2c).'
}

# ---------------------------------------------------------------- commands

function Show-Usage {
    Say 'zk-bridge setup: install the bridge and run it as a Windows service, in one command'
    Say ''
    Say 'Usage:'
    Say '  setup.cmd               Interactive setup: Node.js, packages, settings, K40 check, service'
    Say '  setup.cmd --yes         The same without questions (uses .env as it is)'
    Say ''
    Say '  setup.cmd status        Is the service running? Plus the last "Status:" line'
    Say '  setup.cmd logs          Follow the log (Ctrl+C to stop watching; the bridge keeps running)'
    Say '  setup.cmd start|stop|restart'
    Say '  setup.cmd test          Device test (stats, users, logs, live punches)'
    Say '  setup.cmd info          Show the current settings'
    Say '  setup.cmd update        Rebuild after an update (git pull if this is a git folder) and restart'
    Say '  setup.cmd uninstall     Remove the service (keeps .env, data\ and logs\)'
    Say '  setup.cmd help          This help'
    Say ''
    Say 'Mac / Linux / Raspberry Pi: use ./setup.sh (same commands).'
}

function Show-Summary {
    Say ''
    Say 'zk-bridge is running as the Windows service ZKBridge. It starts by itself when Windows'
    Say 'starts (even before anyone logs in) and restarts after a crash.'
    Say ''
    Say ('  {0,-6} {1}:{2} (clock in {3})' -f 'K40', $script:Values['DEVICE_IP'], (Get-DevicePort), $script:Values['DEVICE_TIMEZONE'])
    Say ('  {0,-6} {1}  (key {2})' -f 'CRM', $script:Values['CRM_BASE_URL'], (Get-Masked ([string]$script:Values['CRM_DEVICE_KEY'])))
    Say ('  {0,-6} {1}' -f 'Log', $LogFile)
    Say ('  {0,-6} {1}' -f 'Queue', $script:Values['OUTBOX_PATH'])
    Say ''
    Say '  The first "Status: OK" line appears about 1 minute after start: setup.cmd status'
    Say '  Manage: setup.cmd status | logs | restart | stop | start | test | update | uninstall'
}

function Invoke-Setup {
    Say ''
    Say 'zk-bridge setup  (ZKTeco K40 -> CRM bridge, Windows)'
    Test-Folder
    Initialize-Node
    $svc = Get-BridgeService
    if ($svc -and $svc.Status -eq 'Running') {
        Info 'Stopping the running bridge while it is set up again'
        Stop-BridgeService
    }
    Install-Packages
    Build-Bridge
    Invoke-SettingsStep
    $reachable = Test-Device
    if ($reachable -and -not $script:AssumeYes) {
        if (Confirm-Step 'Run the full device test now (stats, users, logs, live punches)?' $false) { Invoke-DeviceTest }
    }
    $mark = Get-LogMark
    Install-BridgeService
    if (-not (Wait-Ready $mark)) {
        Fail 'Setup finished, but the bridge did not start properly (see above). Fix it, then: setup.cmd restart'
    }
    if (-not $script:AssumeYes) { Set-LaptopPower }
    Show-Summary
    Say ''
    Ok 'All set!'
}

function Show-Status {
    $svc = Get-BridgeService
    if (-not $svc) { Say "The service isn't installed. Run setup.cmd"; return }
    if ($svc.Status -eq 'Running') { Ok "Service $ServiceName is running" }
    else { Warn "Service $ServiceName is $($svc.Status) (setup.cmd start)" }
    $line = Get-LastStatusLine
    if ($line) { Say "   Last status: $line" } else { Say '   No "Status:" line yet (it comes about 1 minute after start).' }
    Say "   Log: $LogFile"
}

function Show-Logs {
    if (-not (Test-Path -LiteralPath $LogFile)) { Fail "No log yet ($LogFile). Run setup.cmd first." }
    Get-Content -LiteralPath $LogFile -Tail 100 -Wait
}

function Invoke-TestCommand {
    if (-not (Test-Path -LiteralPath (Join-Path $Root 'dist\poc.js'))) { Fail 'Not built yet. Run setup.cmd first.' }
    if (-not (Test-Path -LiteralPath $EnvFile)) { Fail 'No .env yet. Run setup.cmd first.' }
    if (-not (Test-NodeOk)) { Fail 'Node.js 22.13+ is needed. Run setup.cmd first.' }
    $svc = Get-BridgeService
    $wasRunning = ($svc -and $svc.Status -eq 'Running')
    if ($wasRunning) { Info 'Stopping the service during the test'; Stop-BridgeService }
    try { Invoke-DeviceTest }
    finally { if ($wasRunning) { Info 'Starting the service again'; Start-BridgeService; Ok 'Service started' } }
}

function Show-Info {
    if (-not (Test-NodeOk)) { Fail 'Node.js 22.13+ is needed. Run setup.cmd first.' }
    Read-Settings
    Say "Settings ($EnvFile)"
    if (-not (Test-Path -LiteralPath $EnvFile)) { Warn 'No .env yet: these are the defaults from .env.example. Run setup.cmd' }
    foreach ($k in $script:Values.Keys) {
        $v = [string]$script:Values[$k]
        if ($k -eq 'CRM_DEVICE_KEY') { $v = Get-Masked $v }
        Say ('  {0,-26} {1}' -f $k, $v)
    }
}

function Invoke-Update {
    Initialize-Node
    if ((Test-Path -LiteralPath (Join-Path $Root '.git')) -and (Get-Command git -ErrorAction SilentlyContinue)) {
        Info 'Getting the latest version (git pull)'
        & git -C $Root pull --ff-only
        if ($LASTEXITCODE -ne 0) { Warn 'git pull failed (local changes?). Rebuilding the current files.' }
    }
    Stop-BridgeService
    Install-Packages
    Build-Bridge
    Read-Settings
    $problems = @(Get-SettingProblems)
    if ($problems.Count -gt 0) {
        foreach ($p in $problems) { Warn $p }
        Fail 'The settings in .env have problems (above). Run setup.cmd to fix them.'
    }
    if (Get-BridgeService) {
        $mark = Get-LogMark
        Start-BridgeService
        if (-not (Wait-Ready $mark)) { Fail 'Updated, but the bridge did not start properly (see above).' }
        Ok 'Updated and running'
    } else {
        Ok "Updated. The service isn't installed yet: run setup.cmd"
    }
}

# ---------------------------------------------------------------- main

$Command = 'setup'
foreach ($a in $ScriptArgs) {
    switch -Regex ([string]$a) {
        '^(-y|--yes|-yes|/y)$' { $script:AssumeYes = $true; continue }
        '^--elevated$' { $script:Elevated = $true; continue }
        '^(-h|--help|-help|help|/\?)$' { $Command = 'help'; continue }
        '^(setup|start|stop|restart|status|logs|test|info|update|uninstall)$' { $Command = $a.ToLowerInvariant(); continue }
        default { Write-Host "Unknown command '$a'. Run: setup.cmd help" -ForegroundColor Red; exit 1 }
    }
}

$exitCode = 0
try {
    Set-Location -LiteralPath $Root
    $needsAdmin = @('setup', 'start', 'stop', 'restart', 'test', 'update', 'uninstall') -contains $Command
    if ($needsAdmin -and -not (Test-Admin)) { Invoke-Elevated }
    switch ($Command) {
        'help' { Show-Usage }
        'setup' { Invoke-Setup }
        'status' { Show-Status }
        'logs' { Show-Logs }
        'info' { Show-Info }
        'test' { Invoke-TestCommand }
        'update' { Invoke-Update }
        'uninstall' { Uninstall-BridgeService }
        'start' { Start-BridgeService; Ok 'Service started' }
        'stop' { Stop-BridgeService; Ok 'Service stopped (it starts again when Windows starts, or with setup.cmd start)' }
        'restart' {
            if (-not (Get-BridgeService)) { Fail "The service isn't installed yet. Run setup.cmd first." }
            Restart-Service -Name $ServiceName
            Ok 'Service restarted'
        }
    }
} catch {
    Write-Host " x   $($_.Exception.Message)" -ForegroundColor Red
    $exitCode = 1
} finally {
    if ($script:Elevated) {
        Write-Host ''
        [void](Read-Host 'Press Enter to close this window')
    }
}
exit $exitCode
