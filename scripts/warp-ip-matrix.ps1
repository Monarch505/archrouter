#!/usr/bin/env pwsh
<#
  warp-ip-matrix.ps1 — ukur distinctness 2 instance WARP pada satu mesin.

  Latar (docs-internal/TASKS.md:80-86 + docs-internal/WINDOWS-BACKBONE-PROOF.md):
  egress IP WARP datang dari pool per colo (bukan per akun), jadi dua akun bisa
  dapat IP yang sama. Yang memisahkannya adalah WAKTU handshake: start serempak
  -> satu IP; bounce bergilir -> biasanya IP berbeda. Guard P1-5 memakai cara
  yang sama (park salah satu, bounce sampai IP-nya beda).

  Fase yang diukur:
    serempak  : start a & b tanpa jeda   -> mereproduksi root cause
    bounce    : a tetap hidup, bounce b  -> jalur yang dipakai guard sungguhan,
                diulang sampai distinct (atau MaxBounce habis) -> tries_needed

  Contoh (Windows):
    pwsh -File scripts\warp-ip-matrix.ps1 `
      -SingBox "$env:USERPROFILE\.archrouter-spike\bin\x64\sing-box.exe" `
      -DirA "$env:USERPROFILE\.archrouter-spike\warp\warp-a" `
      -DirB "$env:USERPROFILE\.archrouter-spike\warp\warp-b" `
      -PortA 12810 -PortB 12811 `
      -SerempakTrials 3 -BounceTrials 6 -MaxBounce 8 `
      -OutCsv "$env:USERPROFILE\.archrouter-spike\logs\ip-matrix.csv"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SingBox,
  [Parameter(Mandatory = $true)][string]$DirA,
  [Parameter(Mandatory = $true)][string]$DirB,
  [int]$PortA = 12810,
  [int]$PortB = 12811,
  [int]$SerempakTrials = 3,
  [int]$BounceTrials = 6,
  [int]$MaxBounce = 8,
  [int]$Settle = 15,
  [int]$Gap = 3,
  [string]$OutCsv = ".\logs\ip-matrix.csv"
)

$ErrorActionPreference = "Stop"
$rows = New-Object System.Collections.Generic.List[object]

function Stop-ByDir([string]$dir) {
  $needle = Split-Path -Leaf $dir
  Get-CimInstance Win32_Process -Filter "Name='sing-box.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$needle*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
function Stop-All {
  Get-Process sing-box -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}
function Start-Inst([string]$dir) {
  $cfg = Join-Path $dir "sing-box.json"
  if (-not (Test-Path -LiteralPath $cfg)) { throw "config missing: $cfg" }
  (Start-Process -FilePath $SingBox -ArgumentList @("run", "-c", $cfg) `
     -RedirectStandardOutput (Join-Path $dir "sb.out.log") `
     -RedirectStandardError  (Join-Path $dir "sb.err.log") `
     -WindowStyle Hidden -PassThru).Id
}
# Probe egress IP lewat SOCKS instance tsb: IP-literal + socks5 (DNS lokal)
# supaya tidak bergantung pada resolver di dalam tunnel.
function Get-Ip([int]$port) {
  $o = & curl.exe -s -m 15 -x "socks5://127.0.0.1:$port" "https://1.1.1.1/cdn-cgi/trace" 2>&1
  if ($LASTEXITCODE -ne 0) { return "curl-err" }
  $m = ($o | Select-String -Pattern '^ip=(\S+)' | Select-Object -First 1)
  if ($m) { return ($m.Line -replace '^ip=', '') }
  return "no-ip"
}
function Record($phase, $trial, $attempt, $ia, $ib) {
  $d = if ($ia -match '^\d+\.' -and $ib -match '^\d+\.') { [string]($ia -ne $ib) } else { "n/a" }
  $rows.Add([pscustomobject]@{ phase = $phase; trial = $trial; attempt = $attempt
      ip_a = $ia; ip_b = $ib; distinct = $d })
  Write-Host ("  {0,-9} t{1} a{2,-2} a={3,-16} b={4,-16} {5}" -f $phase, $trial, $attempt, $ia, $ib, $d) `
    -ForegroundColor $(if ($d -eq "True") { "Green" } else { "Yellow" })
  $d
}

$outDir = Split-Path -Parent $OutCsv
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
Write-Host "warp-ip-matrix  singbox=$SingBox  serempak=$SerempakTrials  bounce=$BounceTrials(max $MaxBounce)" -ForegroundColor Cyan

# --- fase 1: serempak (reproduksi root cause) --------------------------------
$simOk = 0
for ($t = 1; $t -le $SerempakTrials; $t++) {
  Stop-All; Start-Sleep -Seconds $Gap
  $null = Start-Inst $DirA; $null = Start-Inst $DirB      # sengaja tanpa jeda
  Start-Sleep -Seconds $Settle
  if ((Record "serempak" $t 1 (Get-Ip $PortA) (Get-Ip $PortB)) -eq "True") { $simOk++ }
}

# --- fase 2: bounce b (jalur guard) -----------------------------------------
$conv = 0; $triesList = @(); $miss = 0
for ($t = 1; $t -le $BounceTrials; $t++) {
  Stop-All; Start-Sleep -Seconds $Gap
  $null = Start-Inst $DirA                                # a sekali, lalu diam
  Start-Sleep -Seconds $Settle
  $done = $false
  for ($k = 1; $k -le $MaxBounce; $k++) {
    Stop-ByDir $DirB; Start-Sleep -Seconds $Gap
    $null = Start-Inst $DirB
    Start-Sleep -Seconds $Settle
    $r = Record "bounce" $t $k (Get-Ip $PortA) (Get-Ip $PortB)
    if ($r -eq "True") { $done = $true; $triesList += $k; $conv++; break }
  }
  if (-not $done) { $miss++ }
}

Stop-All
$rows | Export-Csv -LiteralPath $OutCsv -NoTypeInformation -Encoding UTF8

$allIps = @($rows | ForEach-Object { $_.ip_a; $_.ip_b } | Where-Object { $_ -match '^\d+\.' } | Sort-Object -Unique)
Write-Host ""
Write-Host "RINGKASAN" -ForegroundColor Cyan
Write-Host "  serempak distinct : $simOk/$SerempakTrials   ( Collision rate )" -ForegroundColor $(if ($simOk -eq 0) { "Yellow" } else { "Green" })
Write-Host "  bounce converge    : $conv/$BounceTrials trial  ( misses: $miss )"
if ($triesList.Count) {
  $avg = [math]::Round((($triesList | Measure-Object -Average).Average), 2)
  Write-Host "  tries until distinct: $($triesList -join ', ')  (avg $avg, max $($triesList | Measure-Object -Maximum | ForEach-Object Maximum))"
}
Write-Host "  IP unik terlihat   : $($allIps -join ', ')"
Write-Host "  CSV                : $OutCsv"
