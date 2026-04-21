cmake_minimum_required(VERSION 3.20)
project(gpu-analyzer LANGUAGES CXX CUDA)

# ─── Standards ────────────────────────────────────────────────────────────────
set(CMAKE_CXX_STANDARD  17)
set(CMAKE_CUDA_STANDARD 17)

# ─── CUDA arch for RTX 3050 (Ampere = sm_86) ─────────────────────────────────
# Change to sm_75 for Turing (RTX 2xxx), sm_70 for Volta, sm_89 for RTX 4xxx
set(CMAKE_CUDA_ARCHITECTURES 86)

# ─── Sources ──────────────────────────────────────────────────────────────────
set(CPP_SOURCES
    main.cpp
    analyzer/parser.cpp
    analyzer/rules.cpp
)

set(CUDA_SOURCES
    kernels/bad_kernel.cu
    kernels/good_kernel.cu
    profiler/runner.cu
    profiler/metrics.cu
)

# ─── Executable ───────────────────────────────────────────────────────────────
add_executable(gpu-analyzer ${CPP_SOURCES} ${CUDA_SOURCES})

target_include_directories(gpu-analyzer PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CUDA_TOOLKIT_INCLUDE_DIRECTORIES}
)

# ─── CUDA flags ───────────────────────────────────────────────────────────────
target_compile_options(gpu-analyzer PRIVATE
    $<$<COMPILE_LANGUAGE:CUDA>:
        --generate-line-info          # line info for Nsight
        -use_fast_math                # allow reciprocal approx
        -Xcompiler -Wall              # pass -Wall to host compiler
        --ptxas-options=-v            # verbose PTX (register/smem usage)
    >
)

# ─── Link CUDA runtime ────────────────────────────────────────────────────────
target_link_libraries(gpu-analyzer PRIVATE
    cuda
    cudart
)

# ─── Build type ───────────────────────────────────────────────────────────────
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

message(STATUS "Build type     : ${CMAKE_BUILD_TYPE}")
message(STATUS "CUDA arch      : ${CMAKE_CUDA_ARCHITECTURES}")
message(STATUS "CUDA toolkit   : ${CMAKE_CUDA_TOOLKIT_INCLUDE_DIRECTORIES}")