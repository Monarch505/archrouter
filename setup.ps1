# setup.ps1 — archrouter on Windows in one command.
#
#   git clone https://github.com/Monarch505/archrouter $env:USERPROFILE\archrouter
#   cd $env:USERPROFILE\archrouter
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1
#
# Installs Node 22 if missing, deploys everything, puts archrouter on the user
# PATH, starts the stack and waits until the API answers.
#
# Flags (all optional): -NoWarp -NoOpencode -Dir PATH -Port N

[CmdletBinding()]
param(
  [switch]$NoWarp,
  [switch]$NoOpencode,
  [string]$Dir = $(if ($env:ARCHROUTER_DIR) { $env:ARCHROUTER_DIR } else { Join-Path $env:USERPROFILE "archrouter" }),
  [int]$Port = $(if ($env:ARCHROUTER_PORT) { [int]$env:ARCHROUTER_PORT } else { 20399 })
)

$ErrorActionPreference = "Stop"
$MinNodeMajor = 22
$RepoUrl = if ($env:ARCHROUTER_REPO_URL) { $env:ARCHROUTER_REPO_URL } else { "https://github.com/Monarch505/archrouter.git" }
$HealthTimeout = 90

function Step($m) { Write-Host "`n==> $m" -ForegroundColor White }
function Ok($m)   { Write-Host "  [ok] $m" -ForegroundColor Green }
function Info($m) { Write-Host "  [..] $m" -ForegroundColor DarkGray }
function Warn2($m){ Write-Host "  [!!] $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "`nFAILED: $m" -ForegroundColor Red; exit 1 }

function Get-NodeMajor {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return 0 }
  try { return [int](node -e "process.stdout.write(String(process.versions.node.split('.')[0]))") } catch { return 0 }
}

function Install-Node {
  Step "Node.js $MinNodeMajor+"
  if ((Get-NodeMajor) -ge $MinNodeMajor) { Ok "node $(node -v) already present"; return }

  if (Get-Command node -ErrorAction SilentlyContinue) {
    Warn2 "node $(node -v) is too old (need >= $MinNodeMajor) — replacing it"
  } else {
    Info "node not found — installing it for you"
  }

  $installed = $false
  # winget first: no admin prompt in most cases when a package is already there.
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Info "installing via winget (OpenJS.NodeJS.LTS)"
    try {
      winget install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements --silent | Out-Null
      $installed = $true
    } catch { Warn2 "winget failed: $($_.Exception.Message)" }
  }
  if (-not $installed -and (Get-Command choco -ErrorAction SilentlyContinue)) {
    Info "installing via chocolatey"
    try { choco install nodejs-lts -y --no-progress | Out-Null; $installed = $true } catch { Warn2 "choco failed: $($_.Exception.Message)" }
  }

  # PATH in this session is stale either way; node may sit in the Program Files dir.
  $candidates = @(
    "$env:ProgramFiles\nodejs",
    "${env:ProgramFiles(x86)}\nodejs",
    "$env:LOCALAPPDATA\Programs\nodejs",
    (Join-Path $env:LOCALAPPDATA "Volta\bin")
  )
  foreach ($c in $candidates) {
    if ((Test-Path (Join-Path $c "node.exe")) -and ($env:Path -notlike "*$c*")) {
      $env:Path = "$c;$env:Path"
    }
  }
  if ((Get-NodeMajor) -ge $MinNodeMajor) { Ok "node $(node -v) ready"; return }

  Die @"
Node $MinNodeMajor+ could not be installed automatically. Install it, then run this again:

    winget install OpenJS.NodeJS.LTS
    (or download https://nodejs.org and run the installer)

Then close and reopen this terminal so PATH updates, and run setup.ps1 again.
"@
}

function Get-Repo {
  Step "Source"
  if (Test-Path (Join-Path $Dir ".git")) {
    Ok "already cloned at $Dir"
    try {
      git -C $Dir fetch -q origin 2>$null
      $remote = git -C $Dir rev-parse --verify origin/main 2>$null
      $head = git -C $Dir rev-parse HEAD
      if ($remote -and $head -ne $remote) {
        if (git -C $Dir status --porcelain) { Warn2 "local edits in the repo — keeping them" }
        else { git -C $Dir reset --hard -q $remote; Ok "updated to $((git -C $Dir rev-parse --short HEAD))" }
      } else { Ok "up to date ($((git -C $Dir rev-parse --short HEAD)))" }
    } catch { Warn2 "could not reach GitHub — staying on the local copy" }
    return
  }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Die "git is required. Install Git for Windows, then run this again." }
  Info "cloning $RepoUrl -> $Dir"
  git clone --depth 1 $RepoUrl $Dir
  if ($LASTEXITCODE -ne 0) { Die "git clone failed. Check your internet connection." }
  Ok "cloned"
}

function Add-ToPath {
  Step "PATH"
  $shim = Join-Path $env:USERPROFILE ".local\bin"
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($userPath -notlike "*$shim*") {
    if (-not $userPath) { [Environment]::SetEnvironmentVariable("Path", $shim, "User") }
    else { [Environment]::SetEnvironmentVariable("Path", "$shim;$userPath", "User") }
    Ok "$shim added to your user PATH (new terminals too)"
  } else { Ok "PATH already set" }
  if ($env:Path -notlike "*$shim*") { $env:Path = "$shim;$env:Path" }
}

function Deploy {
  Step "Deploy (warp accounts, binaries, stack)"
  $log = Join-Path $env:USERPROFILE ".archrouter\data\logs\install.log"
  New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null

  # Tee the output, never pipe to Select-Object -First: truncating kills the
  # installer and loses the one-and-only API key.
  & node (Join-Path $Dir "install.js") --unattended 2>&1 | Tee-Object -FilePath $log
  if ($LASTEXITCODE -ne 0) { Die "install.js failed (exit $LASTEXITCODE). Full log kept at $log" }
  Ok "install.js finished"
  return $log
}

function Save-FirstKey($LogPath) {
  # Shown once by design; a scrolled-away key would be unrecoverable.
  $dest = Join-Path $env:USERPROFILE ".archrouter\data\first-key.txt"
  New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
  if ((Test-Path $dest) -and (Get-Item $dest).Length -gt 0) { Ok "a first-run key was already saved at $dest"; return }
  if (-not (Test-Path $LogPath)) { return }
  $m = Select-String -Path $LogPath -Pattern 'sk-arch-[A-Za-z0-9_-]{32}' -AllMatches | Select-Object -First 1
  if ($m) {
    Set-Content -LiteralPath $dest -Value $m.Matches[0].Value -NoNewline
    Ok "API key saved to $dest"
  }
}

function Wait-Healthy {
  Step "Waiting for the API"
  $deadline = (Get-Date).AddSeconds($HealthTimeout)
  $waited = 0
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3 -SkipHttpErrorCheck
      if ($r.StatusCode -eq 200) { Ok "API answers on :$Port"; return $true }
    } catch {}
    Start-Sleep -Seconds 2
    $waited += 2
    if ($waited % 10 -eq 0) { Info "still waiting ($waited s)" }
  }
  Warn2 "API did not answer within ${HealthTimeout}s"
  return $false
}

function Wire-Opencode {
  Step "opencode"
  if (-not (Get-Command opencode -ErrorAction SilentlyContinue)) {
    Info "opencode is not installed here — skipped (nothing to wire)"
    return
  }
  & node (Join-Path $Dir "archrouter.js") connect-opencode
  if ($LASTEXITCODE -eq 0) { Ok "provider entry written to your opencode.json" }
  else { Warn2 "could not write opencode.json — run: archrouter connect-opencode" }
}

Write-Host "archrouter setup - one command, then it just runs." -ForegroundColor White
Install-Node
Get-Repo
Add-ToPath
$log = Deploy
Save-FirstKey $log

if (-not (Wait-Healthy)) {
  Write-Host "`nStill not answering. Diagnostics:" -ForegroundColor Yellow
  & node (Join-Path $Dir "archrouter.js") doctor
  Die "setup did not reach a healthy state"
}

Step "Status"
& node (Join-Path $Dir "archrouter.js") status

if (-not $NoOpencode) { Wire-Opencode }

Write-Host "`nDONE  archrouter is running." -ForegroundColor Green
Write-Host @"

  dashboard   http://127.0.0.1:$Port/
  models      only the -free tier; paid ids are refused
  opencode    /connect -> Other -> archrouter -> paste the key printed above

  archrouter status      # pids, egress IPs, invariant_ok
  archrouter doctor      # full health check
  archrouter stop        # stop everything (there is no autostart)
  archrouter update      # pull a newer version and restart

  If the key scrolled away: create another with  archrouter key
"@ -ForegroundColor Gray