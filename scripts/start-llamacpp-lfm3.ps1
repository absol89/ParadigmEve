# Start the independent, loopback-only llama.cpp backend used by Eve's composer picker.
# Nothing here starts/stops Ollama or Eve. Keep this terminal open while using llama.cpp.
param(
  [string]$ServerPath = '',
  [string]$ModelPath = '',
  [string]$ModelAlias = 'lfm3-q4',
  [ValidateRange(256,262144)][int]$Context = 8192,
  [ValidateRange(0,999)][int]$GpuLayers = 99,
  [ValidateRange(1,32)][int]$Threads = 4,
  [ValidateRange(1,8192)][int]$BatchSize = 256,
  [ValidateRange(0,2)][double]$Temperature = 0.1,
  [ValidateRange(1,1000)][int]$TopK = 50,
  [ValidateRange(0.1,3)][double]$RepeatPenalty = 1.1
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$runtimeRoot = Join-Path $projectRoot 'ParadigmEve-local-runtimes'
if (!$ServerPath) { $ServerPath = Join-Path $runtimeRoot 'llama.cpp\b12008-vulkan\llama-server.exe' }
if (!$ModelPath) { $ModelPath = Join-Path $runtimeRoot 'models\LFM3-1.7B-Q4_K_M.gguf' }
if (!(Test-Path -LiteralPath $ServerPath -PathType Leaf)) { throw "llama-server missing: $ServerPath" }
if (!(Test-Path -LiteralPath $ModelPath -PathType Leaf)) { throw "GGUF missing: $ModelPath" }
if (Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue) {
  throw 'Port 8080 is occupied. Do not start a second llama.cpp server or replace the process using it.'
}
$inv = [Globalization.CultureInfo]::InvariantCulture
$argsList = @(
  '--model', $ModelPath, '--alias', $ModelAlias,
  '--host', '127.0.0.1', '--port', '8080',
  '--ctx-size', [string]$Context, '--gpu-layers', [string]$GpuLayers,
  '--threads', [string]$Threads, '--batch-size', [string]$BatchSize,
  '--parallel', '1', '--no-webui', '--cors-origins', 'localhost',
  '--temp', $Temperature.ToString($inv),
  '--top-k', [string]$TopK,
  '--repeat-penalty', $RepeatPenalty.ToString($inv)
)
Write-Host "Starting llama.cpp at http://127.0.0.1:8080/v1 with $ModelAlias (Ctrl+C stops this model server, not Eve)."
& $ServerPath @argsList
if ($LASTEXITCODE -ne 0) { throw "llama-server exited with code $LASTEXITCODE" }
