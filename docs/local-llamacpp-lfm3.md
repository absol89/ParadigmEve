# Optional llama.cpp LFM3 backend (Windows)

Eve's composer has a separate **llama.cpp** provider beside **Ollama** and **OpenRouter**.
Selecting it is explicit and session-local. The server's model is discovered live from
`http://127.0.0.1:8080/v1/models`; a missing server or model is an error, never a silent
fallback to Ollama or a cloud service. Existing Ollama models, cloud sign-in, key, worker
setting, and ChatGPT selection are not changed.

## This Windows machine

- CPU: Intel i5-8300H, 4 cores / 8 threads; RAM: ~16 GB.
- GPU: NVIDIA Quadro P600, ~4 GB VRAM. Prefer the official Windows x64 Vulkan build;
  the GPU may be faster than CPU-only, but measure on this hardware.
- Baseline portable binary: upstream llama.cpp **b12008** (0.8.0-dev), from its official
  GitHub release `llama-b12008-bin-win-vulkan-x64.zip`.
- Official Liquid AI **LFM3-1.7B-Q4_K_M.gguf** (~1.1 GB). It is text-only. Do not use the
  unrelated MLX artifact on Windows. LFM3 requires llama.cpp v0.8.0 / b11960 or newer.

The portable files live outside the Git checkout, under sibling
`ParadigmEve-local-runtimes/llama.cpp/b12008-vulkan/` and
`ParadigmEve-local-runtimes/models/`. They are not silently bundled into Eve installers
or launched on Windows login. Upgrading them does not replace Ollama.

## Start and tune

In a PowerShell terminal, from the 2.4.6 repository:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-llamacpp-lfm3.ps1
# Lower GPU offload or context if memory is tight:
powershell -ExecutionPolicy Bypass -File .\scripts\start-llamacpp-lfm3.ps1 -GpuLayers 20 -Context 4096
# Liquid AI's suggested math/science sampling:
powershell -ExecutionPolicy Bypass -File .\scripts\start-llamacpp-lfm3.ps1 -Temperature 1 -TopK 20
```

Defaults: loopback port 8080; alias `lfm3-q4`; 8192-token context; up to 99 GPU
layers; 4 CPU threads; batch 256; single server slot; temperature 0.1; top-k 50;
repeat penalty 1.1. Parameters are deliberately passed to native llama.cpp, not
Ollama. The 256K model maximum is *not* a promise that this GPU can hold a 256K KV
cache; raise context incrementally while watching GPU memory, latency and truncation.
Use `-ServerPath` / `-ModelPath` to point to another audited compatible binary/GGUF.

Once `http://127.0.0.1:8080/v1/models` reports `lfm3-q4`, open Eve's composer
model picker → **llama.cpp** → **lfm3-q4**. Nothing is auto-selected. The first request
to a different privacy route still goes through Eve's history-switch consent.
The local-only lock allows local Ollama and llama.cpp, not Ollama Cloud or OpenRouter.

The current llama.cpp adapter uses the OpenAI-compatible chat/tool-call endpoint,
not Ollama's `/api/chat` or `/api/show`, and never sends the Ollama API key.
It queries the server's context setting and refuses requests estimated not to fit,
so a too-small context is visible rather than silently dropping a Thread or tools.
The launcher binds to loopback and restricts CORS origins to localhost.
The backend supports text input and the existing app-authorized local tool loop.
Vision/audio and advanced per-turn sampling UI are not asserted; tune the native
server launch flags. For an agentic coding task, LFM3's small size is a limitation
even though it is optimized for local agent/tool use.

## Compare Ollama v0.40.13 (offline, same GGUF)

Ollama's [v0.40.13 release](https://github.com/ollama/ollama/releases/tag/v0.40.13)
explicitly adds LFM3 support on Windows. Use an already installed Ollama executable;
this procedure downloads nothing and does not replace the app or its model catalog.
To import the exact GGUF used by llama.cpp, create a temporary Ollama Modelfile
with `FROM` pointing to the full local `LFM3-1.7B-Q4_K_M.gguf` path and run
`ollama create eve-lfm3-q4-bench -f <ModelfilePath>`. Use a unique temporary
benchmark model name; never overwrite an existing Ollama model. No cloud pull is
needed. Do this only after any separate Ollama installer has finished.

With the other backend's model *not loaded into the 4 GB GPU*, warm up and measure
the first backend, then the second. The following script only sends local HTTP
requests; it neither installs nor shuts down servers, and records one excluded
warmup plus three timed samples, reporting wall-clock latency and decoding speed:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\benchmark-lfm3.ps1 -Backend llamacpp -Model lfm3-q4
powershell -ExecutionPolicy Bypass -File .\scripts\benchmark-lfm3.ps1 -Backend ollama -Model eve-lfm3-q4-bench
```

Both requests use context 8192, up to 128 output tokens, temperature 0.1, top-k 50,
top-p 1, repeat penalty 1.1, seed 42, and a matching user prompt. Ollama's options
request 4 CPU threads and up to 99 GPU layers; the llama.cpp launcher sets those
at startup. Check actual GPU offload in the server logs; the same requested flags
do not guarantee the same GPU/CPU execution. For a robust ranking, run opposite
orders and compare per-run decode throughput, latency and model output quality.
The tool-loop test is separate from raw generation throughput.
To test a 64K context configuration (not a full-context recall test), start the
llama.cpp server with `-Context 65536` and pass `-Context 65536` to both
benchmark script runs; Ollama receives `num_ctx=65536` for each request.

## Sources and verification

- [Official LFM3 GGUF and recommended sampling](https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF).
- [Official llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases).
- [llama-server command-line and API](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).

On 30 October 2026, the b12008 Windows Vulkan archive was verified against its
GitHub asset digest: `8ebb14fe8ef435489fad1a8a168d7a3083359908cca509431cc3468e83058026`.
The official Q4_K_M GGUF is 1,099,627,808 bytes, SHA-256
`3793e1e6e2266919d6e015287221b41100175a98eddaba92e111aed3b05c93c4`.
Record live benchmark and tool-loop evidence separately from source tests.
