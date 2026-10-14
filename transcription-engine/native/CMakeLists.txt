# Vulkan build of the pinned whisper.cpp plus ggml-probe, from the same ggml sources.
#
#   cmake -S transcription-engine/native -B <build> -G "Visual Studio 17 2022" -A x64
#         -DWHISPER_CPP_DIR=<whisper.cpp v1.9.4 checkout>
#         -DVulkan_INCLUDE_DIR=<vulkan headers include> -DVulkan_LIBRARY=<vulkan-1.lib>
#         -DVulkan_GLSLC_EXECUTABLE=<glslc.exe>
#   cmake --build <build> --config Release --target whisper-cli ggml-probe
#
# See scripts/build-whisper-vulkan.mjs, which supplies pinned inputs and verifies the result.
cmake_minimum_required(VERSION 3.21)
project(ldw_native C CXX)

set(WHISPER_CPP_DIR "" CACHE PATH "whisper.cpp source checkout (pinned in transcription-engine/lock/components.json)")
if(NOT EXISTS "${WHISPER_CPP_DIR}/CMakeLists.txt")
  message(FATAL_ERROR "WHISPER_CPP_DIR must point at a whisper.cpp checkout")
endif()

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(GGML_VULKAN ON CACHE BOOL "" FORCE)
set(GGML_CUDA OFF CACHE BOOL "" FORCE)
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
set(GGML_AVX2 ON CACHE BOOL "" FORCE)
set(GGML_FMA ON CACHE BOOL "" FORCE)
set(GGML_F16C ON CACHE BOOL "" FORCE)
set(WHISPER_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES ON CACHE BOOL "" FORCE)  # whisper-cli lives in examples/; off when not top-level
set(WHISPER_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(WHISPER_SDL2 OFF CACHE BOOL "" FORCE)
set(WHISPER_CURL OFF CACHE BOOL "" FORCE)

add_subdirectory("${WHISPER_CPP_DIR}" whisper.cpp)

# ggml-vulkan.cpp includes <spirv/unified1/spirv.hpp>. The SDK puts it beside the Vulkan headers;
# without the SDK it comes from the SPIRV-Headers package found via SPIRV-Headers_DIR.
get_filename_component(LDW_SPIRV_INCLUDE "${SPIRV-Headers_DIR}/../../../include" ABSOLUTE)
if(TARGET ggml-vulkan AND EXISTS "${LDW_SPIRV_INCLUDE}/spirv/unified1/spirv.hpp")
  target_include_directories(ggml-vulkan PRIVATE "${LDW_SPIRV_INCLUDE}")
endif()

add_executable(ggml-probe ggml-probe/ggml-probe.c)
target_link_libraries(ggml-probe PRIVATE ggml)
