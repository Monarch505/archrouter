#Requires -Version 7
# verify-free-only.ps1 — proves the router serves only the -free tier:
# the catalogue hides paid ids and a request for one is refused before it
# reaches upstream. Throwaway instance (own port, own ARCHROUTER_HOME), then
# killed. Never touches the live stack.
#
# Run: pwsh -File scripts/verify-free-only.ps1

$ErrorActionPreference = "Stop"
$Repo    = Split-Path -Parent $PSScriptRoot
$Port    = 21396
$TmpHome = Join-Path $env:TEMP "archrouter-verify-freeonly"
$Base    = "http://127.0.0.1:$Port"

if (Test-Path -LiteralPath $TmpHome) { Remove-Item -Recurse -Force -LiteralPath $TmpHome }
New-Item -ItemType Directory -Force -Path $TmpHome | Out-Null
$env:ARCHROUTER_HOME = $TmpHome
$env:ARCHROUTER_MODE = "none"
Remove-Item Env:\ARCHROUTER_FREE_ONLY -ErrorAction SilentlyContinue

$proc = Start-Process -FilePath "node" `
  -ArgumentList @("server/server.js", "--port", "$Port", "--mode", "none") `
  -WorkingDirectory $Repo -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $TmpHome "out.log") `
  -RedirectStandardError  (Join-Path $TmpHome "err.log")

$fail = 0
function Say($ok, $msg) {
  if ($ok) { "  ok  $msg" } else { $script:fail++; "  FAIL $msg" }
}
function Hit($method, $path, $body) {
  $h = @{}
  if ($body) { $h["Content-Type"] = "application/json" }
  try {
    $p = @{ Method = $method; Uri = "$Base$path"; TimeoutSec = 25; Headers = $h; SkipHttpErrorCheck = $true }
    if ($body) { $p["Body"] = ($body | ConvertTo-Json -Compress) }
    $r = Invoke-WebRequest @p
    $j = $null; try { $j = $r.Content | ConvertFrom-Json } catch {}
    return @{ Status = [int]$r.StatusCode; Json = $j; Raw = $r.Content }
  } catch { return @{ Status = 0; Json = $null; Raw = $_.Exception.Message } }
}

try {
  $up = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    if ((Hit "GET" "/health").Status -eq 200) { $up = $true; break }
  }
  Say $up "instance up on $Port (pid $($proc.Id))"
  if (-not $up) { throw "instance never became healthy" }

  # Force a real upstream fetch so the catalogue is not an empty optimistic stub.
  Hit "POST" "/api/models/refresh" | Out-Null
  $m = Hit "GET" "/v1/models"
  $ids = @($m.Json.data | ForEach-Object { $_.id })
  Say ($m.Status -eq 200 -and $ids.Count -gt 0) "GET /v1/models -> $($ids.Count) models"

  $notFree = @($ids | Where-Object { $_ -notlike "*-free" })
  Say ($notFree.Count -eq 0) "catalogue contains no non-free model ($($notFree.Count) found)"
  if ($notFree.Count -gt 0) { $notFree | Select-Object -First 5 | ForEach-Object { "        leaked: $_" } }

  $free = @($ids | Where-Object { $_ -like "*-free" })
  Say ($free.Count -eq $ids.Count) "every listed model ends in -free ($($free.Count)/$($ids.Count))"

  $paid = Hit "POST" "/v1/chat/completions" @{ model = "oc/claude-opus-5-5"; messages = @(@{ role = "user"; content = "hi" }); max_tokens = 5 }
  Say ($paid.Status -eq 400 -and "$($paid.Raw)" -match "model_not_free") "paid model id -> 400 model_not_free (never reaches upstream)"

  $paid2 = Hit "POST" "/v1/chat/completions" @{ model = "muse-spark-1.3"; messages = @(@{ role = "user"; content = "hi" }); max_tokens = 5 }
  Say ($paid2.Status -eq 400 -and "$($paid2.Raw)" -match "model_not_free") "paid sibling of a free model -> 400 too"

  $missing = Hit "POST" "/v1/chat/completions" @{ model = "oc/totally-made-up"; messages = @(@{ role = "user"; content = "hi" }); max_tokens = 5 }
  Say ($missing.Status -eq 400 -and "$($missing.Raw)" -match "model_not_free") "unknown id -> 400 model_not_free, not passed upstream"

  $msgs = Hit "POST" "/v1/messages" @{ model = "claude-opus-5-5"; max_tokens = 5; messages = @(@{ role = "user"; content = "hi" }) }
  Say ($msgs.Status -eq 400 -and "$($msgs.Raw)" -match "model_not_free") "anthropic route refuses a paid id too"

  # The first free model in the list must actually work end to end.
  $chatModel = @($m.Json.data | Where-Object { $_.capabilities.kind -eq "chat" } | Select-Object -First 1)
  $pick = $chatModel[0].id
  $bare = $pick -replace '^oc/', ''
  $chat = Hit "POST" "/v1/chat/completions" @{ model = $pick; messages = @(@{ role = "user"; content = "reply with the single word ok" }); max_tokens = 16; stream = $false }
  Say ($chat.Status -eq 200) "free model '$bare' answered 200 (real upstream call)"

  $combo = Hit "POST" "/api/combos" @{ name = "Paid"; model = "claude-opus-5-5" }
  Say ($combo.Status -eq 400 -and "$($combo.Raw)" -match "free") "combo pointing at a paid model -> 400"

  $combo2 = Hit "POST" "/api/combos" @{ name = "Bunny"; model = "space-bunny-free" }
  Say ($combo2.Status -eq 200) "combo pointing at a free model -> accepted"

  # A combo added at runtime is not in the catalogue until the next restart
  # (the cache keeps the config it was built with), so its acceptance is
  # checked through the endpoint above, not through /v1/models.

  Hit "POST" "/api/models/refresh" | Out-Null
  $snippet = Hit "GET" "/api/opencode/snippet"
  $fragIds = @($snippet.Json.fragment.provider.archrouter.models.PSObject.Properties.Name)
  $badFrag = @($fragIds | Where-Object { $_ -notlike "*-free" })
  Say ($badFrag.Count -eq 0) "opencode snippet offers only -free models ($($fragIds.Count) models)"
} finally {
  if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 400
  if (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue) { "  WARN pid $($proc.Id) still alive" } else { "  instance stopped" }
  $err = (Get-Content -LiteralPath (Join-Path $TmpHome "err.log") -Raw -ErrorAction SilentlyContinue)
  if ($err -and $err.Trim()) { "  stderr: $($err.Trim())" }
  Remove-Item -Recurse -Force -LiteralPath $TmpHome -ErrorAction SilentlyContinue
  "  temp home removed: $(-not (Test-Path -LiteralPath $TmpHome))"
}

if ($fail -eq 0) { "`nRESULT: ALL PASS" } else { "`nRESULT: $fail FAILED"; exit 1 }
