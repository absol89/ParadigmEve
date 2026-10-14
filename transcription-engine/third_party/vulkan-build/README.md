# Vulkan build inputs for the GPU transcription engine

These files are **build inputs only**. They let `scripts/build-whisper-vulkan.mjs` compile whisper.cpp's
Vulkan backend without the LunarG Vulkan SDK and without admin rights. None of them ship in the
installer. On a user's machine the GPU driver provides the Vulkan runtime (`vulkan-1.dll`).

| Path | What | Upstream (exact commits in `SOURCES.txt`) | Licence |
| --- | --- | --- | --- |
| `win32-x64/bin/glslc.exe` | GLSL → SPIR-V compiler used to build ggml's compute shaders | google/shaderc v2026.4 with its pinned glslang, SPIRV-Tools, SPIRV-Headers, abseil, re2, effcee | Apache-2.0 (shaderc, SPIRV-Tools), BSD-3/Apache-2.0 (glslang), MIT (SPIRV-Headers) |
| `win32-x64/lib/vulkan-1.lib` | Import library for the system Vulkan loader | KhronosGroup/Vulkan-Loader v1.4.365 | Apache-2.0 |
| `include/` | Vulkan C and C++ headers (`vulkan/`, `vk_video/`) | KhronosGroup/Vulkan-Headers v1.4.365 | Apache-2.0 / MIT |
| `spirv-headers/` | SPIR-V headers + CMake package ggml requires | KhronosGroup/SPIRV-Headers (as pinned by shaderc) | MIT |

Licence texts are in `licenses/`. Every file is listed with its SHA-256 in `SHA256SUMS.txt`; the
build script refuses to run if any file differs.

## Rebuilding these files

Everything here is built from the pinned official sources, with no SDK. The recipe used on
2026-10-14 (Windows x64, Visual Studio Build Tools 2022, CMake 3.31) is:

1. Clone Vulkan-Headers and Vulkan-Loader at `v1.4.365`, and shaderc at `v2026.4`. In shaderc, run
   `python utils/git-sync-deps` to fetch the dependency commits it pins.
2. Build `glslc_exe`. Use the shaderc CMake options `SHADERC_SKIP_TESTS`, `SHADERC_SKIP_EXAMPLES`,
   `SPIRV_SKIP_TESTS` and `SPIRV_SKIP_EXECUTABLES`, and set `SHADERC_ENABLE_SHARED_CRT=OFF`.
3. Install Vulkan-Headers. Build the Vulkan-Loader `vulkan` target for its import library.
4. Install shaderc's pinned `third_party/spirv-headers`.
5. Copy the results here and regenerate `SHA256SUMS.txt` (sha256 of every file except itself and
   this README).

Linux x64/arm64 `glslc` builds go in `linux-x64/` and `linux-arm64/` once the engine is packaged
for Linux. The Linux build links the system `libvulkan.so.1` and needs no import library. macOS
uses whisper.cpp's Metal backend and needs nothing from this folder.
