#Requires -Version 7
# verify-auth-toggle.ps1 — drives the API-key switch end to end against a
# throwaway router instance (own port, own ARCHROUTER_HOME, own DB), then kills
# it. Never touches the live stack or the real database.
#
# Run: pwsh -File scripts/verify-auth-toggle.ps1

$ErrorActionPreference = "Stop"
$Repo    = Split-Path -Parent $PSScriptRoot
$Port    = 21397
$TmpHome    = Join-Path $env:TEMP "archrouter-verify-auth"
$Base    = "http://127.0.0.1:$Port"
$LogOut  = Join-Path $TmpHome "server.out.log"
$LogErr  = Join-Path $TmpHome "server.err.log"

if (Test-Path -LiteralPath $TmpHome) { Remove-Item -Recurse -Force -LiteralPath $TmpHome }
New-Item -ItemType Directory -Force -Path $TmpHome | Out-Null

$env:ARCHROUTER_HOME = $TmpHome
$env:ARCHROUTER_MODE = "none"
Remove-Item Env:\ARCHROUTER_KEY -ErrorAction SilentlyContinue
Remove-Item Env:\ARCHROUTER_REQUIRE_AUTH -ErrorAction SilentlyContinue

$proc = Start-Process -FilePath "node" `
  -ArgumentList @("server/server.js", "--port", "$Port", "--mode", "none") `
  -WorkingDirectory $Repo -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput $LogOut -RedirectStandardError $LogErr

$fail = 0
function Say($ok, $msg) {
  if ($ok) { "  ok  $msg" } else { $script:fail++; "  FAIL $msg" }
}

function Hit($method, $path, $body, $key) {
  $h = @{}
  if ($body) { $h["Content-Type"] = "application/json" }
  if ($key)  { $h["Authorization"] = "Bearer $key" }
  try {
    $p = @{ Method = $method; Uri = "$Base$path"; TimeoutSec = 10; Headers = $h; SkipHttpErrorCheck = $true }
    if ($body) { $p["Body"] = ($body | ConvertTo-Json -Compress) }
    $r = Invoke-WebRequest @p
    $json = $null
    try { $json = $r.Content | ConvertFrom-Json } catch {}
    return @{ Status = [int]$r.StatusCode; Json = $json }
  } catch {
    return @{ Status = 0; Json = $null; Err = $_.Exception.Message }
  }
}

try {
  # wait for the listener, bounded
  $up = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    if ((Hit "GET" "/health").Status -eq 200) { $up = $true; break }
  }
  Say $up "instance up on $Port (pid $($proc.Id))"
  if (-not $up) { throw "instance never became healthy" }

  $st = Hit "GET" "/api/status"
  Say ($st.Status -eq 200 -and -not $st.Json.auth.requireAuth -and $st.Json.auth.mode -eq "auto" -and $st.Json.auth.bootstrapOpen) `
      "fresh install: open, mode=auto, bootstrapOpen"

  $k = Hit "GET" "/api/keys"
  Say ($k.Status -eq 200 -and $k.Json.bootstrapOpen) "GET /api/keys open while bootstrap"

  $c = Hit "POST" "/api/keys" @{ name = "verify" }
  $key = $c.Json.key
  Say ($c.Status -eq 201 -and $key -match '^sk-arch-') "POST /api/keys -> 201, key issued"
  $id = $c.Json.id

  $st = Hit "GET" "/api/status"
  Say ($st.Json.auth.requireAuth -and $st.Json.auth.source -eq "auto" -and $st.Json.auth.enabledKeys -eq 1) `
      "auto mode closes as soon as an enabled key exists"

  Say ((Hit "POST" "/api/config" @{ retries = 3 }).Status -eq 401) "POST /api/config without key -> 401"
  Say ((Hit "POST" "/api/config" @{ retries = 3 } $key).Status -eq 200) "POST /api/config with key -> 200"
  Say ((Hit "GET" "/v1/models").Status -eq 401) "GET /v1/models without key -> 401"

  $t = Hit "POST" "/api/keys/toggle" @{ id = $id; active = $false } $key
  Say ($t.Status -eq 200 -and $t.Json.keys[0].active -eq $false -and -not $t.Json.auth.required) `
      "disable last key -> auto mode reopens immediately (no restart)"
  Say ((Hit "POST" "/api/config" @{ retries = 3 }).Status -eq 200) "POST /api/config open again after disable"

  # A dead key is only actually consulted while a key is demanded, so pin the
  # mode to "on" for the refusal checks.
  Hit "POST" "/api/keys/toggle" @{ id = $id; active = $true } $key | Out-Null
  $m = Hit "POST" "/api/auth/mode" @{ mode = "on" } $key
  Say ($m.Status -eq 200 -and $m.Json.auth.required -and $m.Json.auth.source -eq "config") "mode=on -> required (source=config)"
  Say ((Hit "POST" "/api/config" @{ retries = 3 }).Status -eq 401) "mode=on blocks even though bootstrapOpen"

  Hit "POST" "/api/keys/toggle" @{ id = $id; active = $false } $key | Out-Null
  Say ((Hit "POST" "/api/config" @{ retries = 3 } $key).Status -eq 401) "mode=on refuses a disabled key"
  Hit "POST" "/api/keys/toggle" @{ id = $id; active = $true } $key | Out-Null
  Say ((Hit "POST" "/api/config" @{ retries = 3 } $key).Status -eq 200) "re-enabling restores the same secret"

  $off = Hit "POST" "/api/auth/mode" @{ mode = "off" } $key
  Say ($off.Status -eq 200 -and -not $off.Json.auth.required) "mode=off -> open"
  Say ((Hit "POST" "/api/config" @{ retries = 3 }).Status -eq 200) "mode=off answers without a key"

  Hit "POST" "/api/auth/mode" @{ mode = "on" } $key | Out-Null
  Hit "POST" "/api/keys/revoke" @{ id = $id } $key | Out-Null
  Say ((Hit "POST" "/api/config" @{ retries = 3 } $key).Status -eq 401) "mode=on refuses a revoked key"

  # The only key is revoked while mode=on: nobody can authenticate, so the mode
  # switch must still answer or the dashboard would be locked out for good.
  $back = Hit "POST" "/api/auth/mode" @{ mode = "auto" }
  Say ($back.Status -eq 200 -and -not $back.Json.auth.required) "mode switch stays reachable while no key is enabled (anti-lockout)"
  Say ((Hit "POST" "/api/config" @{ retries = 3 }).Status -eq 200) "auto mode reopens after the last key is revoked"

  Say ((Hit "GET" "/v1/models?key=$key").Status -eq 200) "?key= is ignored (open mode answers, no 401 bypass)"
} finally {
  if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 400
  if (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue) { "  WARN pid $($proc.Id) still alive" }
  else { "  instance stopped" }
  $err = (Get-Content -LiteralPath $LogErr -Raw -ErrorAction SilentlyContinue)
  if ($err -and $err.Trim()) { "  stderr: $($err.Trim())" }
  Remove-Item -Recurse -Force -LiteralPath $TmpHome -ErrorAction SilentlyContinue
  "  temp home removed: $(-not (Test-Path -LiteralPath $TmpHome))"
}

if ($fail -eq 0) { "`nRESULT: ALL PASS" } else { "`nRESULT: $fail FAILED"; exit 1 }
