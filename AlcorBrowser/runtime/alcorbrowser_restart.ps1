<#
.SYNOPSIS
  AlcorBrowser restart lane (Windows): restart the broker and make sure the browser reattaches.

.DESCRIPTION
  Started on demand by the scheduled task "AlcorBrowserRestart" (docs\MANUAL.md shows how to
  register it), which the browser_restart tool and the popup's Restart button run:

      schtasks /Run /TN AlcorBrowserRestart

  Why a scheduled task: this script stops the broker, so it cannot be a child of the broker. Task
  Scheduler runs it outside the broker's process tree.

  Steps
    1. Wait a moment, so the HTTP response of the call that started this lane gets out.
    2. Stop this install's broker and native hosts (matched by their script path, so another
       install on the same machine is left alone).
    3. Start the broker, hidden.
    4. Make sure the browser profile is open (a closed profile cannot run the extension), unless
       -NoLaunch, then wait for the extension to attach.
  The outcome is written to <home>\state\restart-last.json.

.PARAMETER Profile
  Chrome profile directory name to reopen (the folder name under "User Data"). Default: Default.
.PARAMETER BrokerHome
  The broker home. Default: $env:ALCOR_BROWSER_HOME, else %LOCALAPPDATA%\AlcorBrowser.
.PARAMETER Port
  The broker's TCP port. Default: whatever companion.py reports (ALCOR_BROWSER_PORT or its default).
.PARAMETER WaitSeconds
  How long to wait for the extension to attach.
.PARAMETER DelaySeconds
  Pause before stopping anything (step 1).
.PARAMETER NoLaunch
  Never start the browser; only report whether the extension attached.
#>
param(
  [string]$Profile = 'Default',
  [string]$BrokerHome = '',
  [int]$Port = 0,
  [int]$WaitSeconds = 45,
  [int]$DelaySeconds = 2,
  [switch]$NoLaunch
)
$ErrorActionPreference = 'Continue'

if (-not $BrokerHome) {
  $BrokerHome = if ($env:ALCOR_BROWSER_HOME) { $env:ALCOR_BROWSER_HOME } else { Join-Path $env:LOCALAPPDATA 'AlcorBrowser' }
}
$rt = Join-Path $BrokerHome 'runtime'
$out = Join-Path $BrokerHome 'state\restart-last.json'
$steps = [ordered]@{ started = (Get-Date).ToString('o') }
New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null

# The child processes find their home and port through the environment.
$env:ALCOR_BROWSER_HOME = $BrokerHome
$python = (Get-Command python.exe -ErrorAction SilentlyContinue).Source
if (-not $python) { throw 'python.exe was not found on PATH' }
$pythonw = Join-Path (Split-Path $python) 'pythonw.exe'
if (-not (Test-Path $pythonw)) { $pythonw = $python }
if ($Port -le 0) { $Port = [int](& $python (Join-Path $rt 'companion.py') port) }
$env:ALCOR_BROWSER_PORT = "$Port"

# Reads the operator status route with the admin token; $null while the broker is not answering.
function Get-BrokerStatus {
  try {
    $token = (Get-Content (Join-Path $BrokerHome 'state\agents\admin.token') -Raw).Trim()
    return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/agents/status" -Headers @{ 'X-Alcor-Browser-Token' = $token } -TimeoutSec 5
  } catch { return $null }
}

# 1-2. Stop this install's broker and native hosts.
Start-Sleep -Seconds $DelaySeconds
$pattern = [regex]::Escape($rt) + '\\(companion|native_host)\.py'
$procs = @(Get-CimInstance Win32_Process -Filter "Name like 'python%'" | Where-Object { $_.CommandLine -match $pattern })
$procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$steps.stopped = $procs.Count
Start-Sleep -Seconds 2

# 3. Start the broker.
Start-Process -FilePath $pythonw -ArgumentList "`"$(Join-Path $rt 'companion.py')`" serve" -WorkingDirectory $rt -WindowStyle Hidden
$deadline = (Get-Date).AddSeconds(15)
do { Start-Sleep -Seconds 1; $s = Get-BrokerStatus } until ($s -or (Get-Date) -gt $deadline)
$steps.broker = [bool]$s

# 4. The extension reconnects by itself within about 30 s; if it has not, open the profile.
$t0 = Get-Date
$deadline = $t0.AddSeconds($WaitSeconds)
$opened = $false
do {
  Start-Sleep -Seconds 2
  $s = Get-BrokerStatus
  if ($s -and @($s.browsers).Count) { break }
  if (-not $NoLaunch -and -not $opened -and ((Get-Date) - $t0).TotalSeconds -gt 12) {
    $chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
                "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
                "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") |
      Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($chrome) { Start-Process -FilePath $chrome -ArgumentList "--profile-directory=`"$Profile`"", 'about:blank' }
    $opened = $true
  }
} until ((Get-Date) -gt $deadline)

$steps.opened_profile = $opened
$steps.browsers = if ($s) { @($s.browsers) } else { @() }
$steps.ok = [bool]($s -and @($s.browsers).Count)
$steps.finished = (Get-Date).ToString('o')
$steps | ConvertTo-Json -Depth 4 | Set-Content -Path $out -Encoding ascii
