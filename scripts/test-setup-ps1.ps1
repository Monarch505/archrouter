# setup.ps1 helper tests — dot-sources setup.ps1 with ARCHROUTER_SETUP_LIB=1 so
# nothing installs, starts or touches your real config.
#
# Run: pwsh -NoProfile -File scripts/test-setup-ps1.ps1

$ErrorActionPreference = "Stop"
$Repo = Split-Path -Parent $PSScriptRoot

$env:ARCHROUTER_SETUP_LIB = "1"
. (Join-Path $Repo "setup.ps1")
$env:ARCHROUTER_SETUP_LIB = $null

# Counters and assertions are defined AFTER the dot-source on purpose: setup.ps1
# exports Ok/Die/Info, and PowerShell function names are case-insensitive, so
# defining them first would leave this suite reporting "0 passed" while printing
# green. Named Test-Ok/Test-Bad so a collision cannot happen at all.
$script:pass = 0
$script:fail = 0
function Test-Ok($m)  { $script:pass++; Write-Host "  [ok] $m" }
function Test-Bad($m, $why) { $script:fail++; Write-Host "  FAIL $m`n        $why" }
function Test-Is($m, $a, $b) { if ($a -eq $b) { Test-Ok $m } else { Test-Bad $m "expected '$b', got '$a'" } }

Write-Host "setup.ps1 helper tests"

# --- every helper the main flow calls must exist -----------------------------
foreach ($fn in @("Step","Ok","Info","Warn2","Die","Get-NodeMajor","Install-Node","Get-Repo","Add-ToPath","Deploy","Save-FirstKey","Wait-Healthy","Wire-Opencode","Invoke-Setup")) {
  if (Get-Command $fn -ErrorAction SilentlyContinue) { Test-Ok "$fn is defined" } else { Test-Bad "$fn is defined" "missing" }
}

# --- node detection ----------------------------------------------------------
Test-Is "MinNodeMajor is 22" $MinNodeMajor 22
$nm = Get-NodeMajor
if (Get-Command node -ErrorAction SilentlyContinue) {
  $real = [int](node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
  Test-Is "Get-NodeMajor matches the running node" $nm $real
} else {
  Test-Ok "node absent here — Get-NodeMajor returned 0 as expected"
  Test-Is "Get-NodeMajor is 0 without node" $nm 0
}

Test-Is "HealthTimeout is a positive int" ($HealthTimeout -gt 0) $true

# --- key rescue --------------------------------------------------------------
# The key is shown once; a scrolled-away terminal must not lock the user out.
$sandbox = Join-Path $env:TEMP "archrouter-ps-probe"
Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $sandbox | Out-Null

$key = "sk-arch-" + ("A" * 32)
$log = Join-Path $sandbox "install.log"
@"
[install] Node.js runtime
  [ok] created key 'default' — copy it now, it cannot be shown again:

    $key

== summary: all good ==
"@ | Set-Content -LiteralPath $log -Encoding utf8

$savedTo = Join-Path $sandbox ".archrouter\data\first-key.txt"
# Save-FirstKey writes under $env:USERPROFILE, so redirect just that.
$origProfile = $env:USERPROFILE
$env:USERPROFILE = $sandbox
Save-FirstKey $log 6>$null
$env:USERPROFILE = $origProfile

if (Test-Path $savedTo) {
  Test-Is "Save-FirstKey rescued the scrolled-away key" ((Get-Content -LiteralPath $savedTo -Raw).Trim()) $key
} else {
  Test-Bad "Save-FirstKey rescued the scrolled-away key" "no file at $savedTo"
}

Save-FirstKey $log 6>$null
Test-Is "Save-FirstKey does not overwrite an existing key" ((Get-Content -LiteralPath $savedTo -Raw).Trim()) $key

# --- health probe ------------------------------------------------------------
# A background job blocked in HttpListener.GetContext() cannot be stopped
# reliably (Stop-Job waits for it), which hangs the suite. Node is guaranteed to
# be here, and a detached process can always be killed.
$Port = 21986
$serverCode = @"
const http=require('http');
http.createServer((q,s)=>{s.writeHead(200,{'Content-Type':'application/json'});s.end('{"status":"ok"}');}).listen($Port,'127.0.0.1');
"@
$serverFile = Join-Path $sandbox "server.js"
Set-Content -LiteralPath $serverFile -Value $serverCode -Encoding utf8
$srv = Start-Process -FilePath "node" -ArgumentList $serverFile -PassThru -WindowStyle Hidden
try {
  Start-Sleep -Milliseconds 900
  $r = Wait-Healthy 6>$null 5>$null
  Test-Is "Wait-Healthy succeeds against a live API" $r $true
} finally {
  if ($srv -and -not $srv.HasExited) { Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue }
}

# Nothing listening on this port: must fail rather than hang.
$HealthTimeout = 4
$r = Wait-Healthy 6>$null 5>$null
Test-Is "Wait-Healthy fails when nothing answers" $r $false

# --- line endings ------------------------------------------------------------
# A CRLF shell script would be refused by Linux; assert the repo keeps them LF.
$sh = @("setup.sh","archrouter","install.sh","scripts/test-setup-sh.sh")
$crlf = @()
foreach ($f in $sh) {
  $p = Join-Path $Repo ($f -replace "/","\")
  if (-not (Test-Path $p)) { continue }
  $bytes = [System.IO.File]::ReadAllBytes($p)
  $text = [Text.Encoding]::UTF8.GetString($bytes)
  if ($text.Contains("`r`n")) { $crlf += $f }
}
if ($crlf.Count -eq 0) { Test-Ok "no CRLF in the shell scripts" } else { Test-Bad "no CRLF in the shell scripts" ($crlf -join ", ") }

$attrs = Get-Content (Join-Path $Repo ".gitattributes") -Raw
foreach ($rule in @("*.sh text eol=lf","setup.sh text eol=lf")) {
  if ($attrs -split "`r?`n" -contains $rule) { Test-Ok ".gitattributes pins '$rule'" } else { Test-Bad ".gitattributes pins '$rule'" "rule missing" }
}

Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "$script:pass passed, $script:fail failed"
if ($script:fail -gt 0) { exit 1 }