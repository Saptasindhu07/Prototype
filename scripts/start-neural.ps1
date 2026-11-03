param(
  [Parameter(Mandatory=$true)][string]$ReadyModelPath
)
$ErrorActionPreference = 'Stop'
$projectPath = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $projectPath
$readyModel = Get-Content -LiteralPath $ReadyModelPath -Raw | ConvertFrom-Json
if ($readyModel.status -ne 'ready-for-joint-connection') { throw 'Model bundle is not verified and ready.' }
if (-not (Test-Path -LiteralPath (Join-Path $readyModel.bundle 'manifest.json'))) { throw 'Bundle is missing.' }
$pythonPath = Join-Path $projectPath 'ml/.venv/Scripts/python.exe'
$nodePath = (Get-Command node -ErrorAction Stop).Source
$oldBundle = $env:AI_MODEL_BUNDLE
$oldEnabled = $env:AI_RECOMMENDATIONS_ENABLED
$oldInferenceUrl = $env:AI_INFERENCE_URL
try {
  $env:AI_MODEL_BUNDLE = $readyModel.bundle
  $env:AI_RECOMMENDATIONS_ENABLED = 'true'
  $env:AI_INFERENCE_URL = 'http://127.0.0.1:8100'
  $existing = $null
  try { $existing = Invoke-RestMethod 'http://127.0.0.1:8100/health' -TimeoutSec 2 } catch {}
  if ($existing) {
    if (-not $existing.ready -or $existing.modelVersion -ne $readyModel.model_version) { throw 'Port 8100 has a different or unready model service.' }
  } else {
    $modelProcess = Start-Process -FilePath $pythonPath -ArgumentList @('-m','uvicorn','inference_api:app','--app-dir','ml','--host','127.0.0.1','--port','8100') -WorkingDirectory $projectPath -WindowStyle Hidden -RedirectStandardOutput (Join-Path $projectPath 'work/ml/inference.stdout.log') -RedirectStandardError (Join-Path $projectPath 'work/ml/inference.stderr.log') -PassThru
    $healthy = $false
    for ($attempt = 0; $attempt -lt 45; $attempt++) {
      try {
        $health = Invoke-RestMethod 'http://127.0.0.1:8100/health' -TimeoutSec 2
        if ($health.ready -and $health.modelVersion -eq $readyModel.model_version) { $healthy = $true; break }
      } catch {}
      if ($modelProcess.HasExited) { throw 'Inference process exited. Check work/ml/inference.stderr.log.' }
      Start-Sleep -Seconds 1
    }
    if (-not $healthy) { throw 'Inference did not become ready. Check inference logs.' }
  }
  & $nodePath 'apps/api/scripts/check-db.js'
  if ($LASTEXITCODE -ne 0) { throw 'MongoDB is unavailable; inference is ready but application activation stopped.' }
  $serverConfig = (& $nodePath --input-type=module -e "import {env} from './apps/api/src/config/env.js'; console.log(JSON.stringify({host:env.host,port:env.port}));") | ConvertFrom-Json
  $apiBase = 'http://' + $serverConfig.host + ':' + $serverConfig.port
  $apiHealth = $null
  try { $apiHealth = Invoke-RestMethod ($apiBase + '/api/health') -TimeoutSec 2 } catch {}
  if ($apiHealth) {
    $status = Invoke-RestMethod ($apiBase + '/api/recommendations/status') -TimeoutSec 2
    if (-not $status.data.enabled) { throw 'An existing API is running with AI disabled; restart that API with the enabled setting.' }
  } else {
    $apiProcess = Start-Process -FilePath $nodePath -ArgumentList @('apps/api/src/server.js') -WorkingDirectory $projectPath -WindowStyle Hidden -RedirectStandardOutput (Join-Path $projectPath 'work/ml/api.stdout.log') -RedirectStandardError (Join-Path $projectPath 'work/ml/api.stderr.log') -PassThru
    $connected = $false
    for ($attempt = 0; $attempt -lt 15; $attempt++) {
      try {
        $status = Invoke-RestMethod ($apiBase + '/api/recommendations/status') -TimeoutSec 2
        if ($status.data.enabled) { $connected = $true; break }
      } catch {}
      if ($apiProcess.HasExited) { throw 'API process exited. Check work/ml/api.stderr.log.' }
      Start-Sleep -Seconds 1
    }
    if (-not $connected) { throw 'API did not become ready.' }
  }
  Write-Output ('Neural API enabled at ' + $apiBase + '; model ' + $readyModel.model_version)
} finally {
  $env:AI_MODEL_BUNDLE = $oldBundle
  $env:AI_RECOMMENDATIONS_ENABLED = $oldEnabled
  $env:AI_INFERENCE_URL = $oldInferenceUrl
}
