# Benchmark an already-running local endpoint. No downloads, model imports, installs,
# background launches or process shutdowns. Run each backend with the other idle.
param(
  [Parameter(Mandatory=$true)][ValidateSet('llamacpp','ollama')][string]$Backend,
  [string]$Model = '',
  [ValidateRange(1,10)][int]$Trials = 3,
  [ValidateRange(256,262144)][int]$Context = 8192,
  [ValidateRange(16,1024)][int]$PredictTokens = 128,
  [string]$OutputPath = ''
)
$ErrorActionPreference = 'Stop'
if (!$Model) {
  $Model = if ($Backend -eq 'llamacpp') { 'lfm3-q4' } else { 'eve-lfm3-q4-bench' }
}
$address = if ($Backend -eq 'llamacpp') { 'http://127.0.0.1:8080/v1/chat/completions' } else { 'http://127.0.0.1:11434/api/chat' }
$prompt = 'Explain in one clear paragraph why a local coding agent should verify the exact destination path and current file content before editing. Include a concrete example.'
$rows = @()

for ($trial = 0; $trial -le $Trials; $trial++) {
  # Trial 0 warms the runtime; exclude it from measurements. Unique suffixes avoid
  # accidentally comparing a cached prompt against a cold prompt on the other backend.
  $suffix = (' Benchmark sample {0:D2}.' -f $trial)
  $messages = @(@{ role = 'user'; content = ($prompt + $suffix) })
  if ($Backend -eq 'ollama') {
    $request = @{
      model = $Model; messages = $messages; stream = $false; keep_alive = '1m'
      options = @{
        num_ctx = $Context; num_predict = $PredictTokens; num_thread = 4
        num_gpu = 99; temperature = 0.1; top_k = 50; top_p = 1.0
        repeat_penalty = 1.1; seed = 42
      }
    }
  } else {
    $request = @{
      model = $Model; messages = $messages; stream = $false
      max_tokens = $PredictTokens; temperature = 0.1; top_k = 50
      top_p = 1.0; repeat_penalty = 1.1; seed = 42; cache_prompt = $false
    }
  }
  $json = ConvertTo-Json -InputObject $request -Depth 12 -Compress
  $timer = [Diagnostics.Stopwatch]::StartNew()
  try {
    $response = Invoke-RestMethod -Uri $address -Method Post -Body $json -ContentType 'application/json; charset=utf-8' -TimeoutSec 180
  } finally { $timer.Stop() }

  if ($Backend -eq 'ollama') {
    $tokens = [int]$response.eval_count
    $promptTokens = [int]$response.prompt_eval_count
    $decodeSec = [double]$response.eval_duration / 1000000000.0
    $content = [string]$response.message.content
    $thinking = [string]$response.message.thinking
  } else {
    $tokens = [int]$response.usage.completion_tokens
    $promptTokens = [int]$response.usage.prompt_tokens
    $decodeSec = if ($null -ne $response.timings -and $null -ne $response.timings.predicted_ms) { [double]$response.timings.predicted_ms / 1000.0 } else { 0.0 }
    $content = [string]$response.choices[0].message.content
    $thinking = [string]$response.choices[0].message.reasoning_content
  }
  $row = [pscustomobject]@{
    backend = $Backend; model = $Model; trial = $trial; warmup = ($trial -eq 0)
    wall_seconds = [math]::Round($timer.Elapsed.TotalSeconds, 3)
    prompt_tokens = $promptTokens; generated_tokens = $tokens
    decode_tokens_per_sec = if ($decodeSec -gt 0) { [math]::Round($tokens / $decodeSec, 2) } else { $null }
    wall_tokens_per_sec = if ($timer.Elapsed.TotalSeconds -gt 0) { [math]::Round($tokens / $timer.Elapsed.TotalSeconds, 2) } else { $null }
    output_chars = $content.Length; thinking_chars = $thinking.Length
  }
  $rows += $row
  $label = if ($trial -eq 0) { 'warmup' } else { "sample $trial" }
  Write-Host ("{0}: {1} tokens, {2}s wall, {3} tok/s decoding" -f $label, $tokens, $row.wall_seconds, $row.decode_tokens_per_sec)
}

$measured = @($rows | Where-Object { -not $_.warmup })
$summary = [pscustomobject]@{
  backend = $Backend; model = $Model; utc = [DateTime]::UtcNow.ToString('o')
  settings = [pscustomobject]@{ context = $Context; max_output_tokens = $PredictTokens; temperature = 0.1; top_k = 50; top_p = 1.0; repeat_penalty = 1.1; seed = 42; threads = 4; gpu_layers_target = 99 }
  mean_wall_seconds = [math]::Round(($measured | Measure-Object -Property wall_seconds -Average).Average, 3)
  mean_decode_tokens_per_sec = if (@($measured | Where-Object { $null -ne $_.decode_tokens_per_sec }).Count -gt 0) { [math]::Round(($measured | Where-Object { $null -ne $_.decode_tokens_per_sec } | Measure-Object -Property decode_tokens_per_sec -Average).Average, 2) } else { $null }
  samples = $rows
}
$report = ConvertTo-Json -InputObject $summary -Depth 10
Write-Output $report
if ($OutputPath) {
  $directory = Split-Path -Parent $OutputPath
  if (!(Test-Path -LiteralPath $directory -PathType Container)) { throw "Output directory does not exist: $directory" }
  if (Test-Path -LiteralPath $OutputPath) { throw "Refusing to overwrite benchmark result: $OutputPath" }
  [IO.File]::WriteAllText($OutputPath, $report, [Text.UTF8Encoding]::new($false))
  Write-Host "Saved new benchmark report: $OutputPath"
}
