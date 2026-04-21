# GPU Kernel Performance Analyzer

> A mini Nsight Compute — static analysis + runtime profiling for CUDA kernels.  
> Built to demonstrate GPU systems knowledge for NVIDIA-track roles.

---

## What it does

| Phase | Feature | Status |
|-------|---------|--------|
| 1 | Static analysis — warp divergence, uncoalesced memory, atomics, shared-mem heuristics | ✅ |
| 2 | Runtime profiling — execution time, theoretical occupancy, memory throughput | ✅ |
| 3 | Bad vs good kernel comparison with speedup factor | ✅ |
| 4 | React dashboard (timeline, bottleneck chart) | 🔜 |

---

## Requirements

- NVIDIA GPU (Ampere/RTX 3xxx recommended — change `CMAKE_CUDA_ARCHITECTURES` for others)
- CUDA Toolkit ≥ 11.8
- CMake ≥ 3.20
- GCC / Clang with C++17

---

## Build

```bash
git clone <repo>
cd gpu-analyzer
mkdir build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release
make -j$(nproc)
```

For RTX 2xxx (Turing), edit `CMakeLists.txt`:
```cmake
set(CMAKE_CUDA_ARCHITECTURES 75)
```

---

## Usage

```bash
# Static analysis — detect issues in any .cu file
./gpu-analyzer --analyze ../kernels/bad_kernel.cu
./gpu-analyzer --analyze ../kernels/good_kernel.cu

# Runtime comparison — bad vs optimised kernel
./gpu-analyzer --compare divergence   # warp divergence test
./gpu-analyzer --compare atomic       # atomic contention test
./gpu-analyzer --compare stencil      # shared memory test

# Run everything
./gpu-analyzer --all
```

---

## Sample output

```
────────────────────────────────────────────────────────────
  Kernel: divergentKernel
  Score : 40/100  ✗ Critical issues
────────────────────────────────────────────────────────────
  [CRITICAL] Warp divergence  (line 12)
             Code   : if (threadIdx.x % 2 == 0) {
             Action : Threads in the same warp take different branches → SIMT serialisation.
                       → Restructure so all 32 threads in a warp take the same path.

  [CRITICAL] Uncoalesced memory access  (line 18)
             Code   : B[threadIdx.x * 8] = A[i];
             Action : Stride-8 access detected.
                       → Consecutive threads should access consecutive addresses.

══════════════════════════════════════════════════════════
  BAD vs GOOD comparison — divergence
══════════════════════════════════════════════════════════
  divergentKernel    : 0.82 ms  | occupancy: 62.5%  | BW: 9.1 GB/s
  noDivergenceKernel : 0.31 ms  | occupancy: 100%   | BW: 24.2 GB/s

  ► Speedup: 2.6x
══════════════════════════════════════════════════════════
```

---

## Architecture

```
gpu-analyzer/
├── analyzer/
│   ├── analyzer.h      # Shared types: Finding, AnalysisResult, ProfileResult
│   ├── parser.cpp      # Read .cu files, extract kernel names, dispatch rules
│   └── rules.cpp       # Heuristic checks: divergence, coalescing, atomics, ...
│
├── profiler/
│   ├── runner.cu       # Allocates GPU memory, orchestrates bad-vs-good runs
│   └── metrics.cu      # CUDA event timing, occupancy API, throughput calc
│
├── kernels/
│   ├── bad_kernel.cu   # Intentionally broken: divergence, stride access, atomics
│   └── good_kernel.cu  # Optimised: branchless, coalesced, warp reduction, shared mem
│
├── main.cpp            # CLI: --analyze | --compare | --all
└── CMakeLists.txt
```

---

## Detection rules

| Rule | What triggers it | Severity |
|------|-----------------|----------|
| Warp divergence | `if (threadIdx.x % N)` pattern | CRITICAL |
| Uncoalesced memory | `A[threadIdx.x * stride]` where stride > 1 | CRITICAL |
| Atomic contention | 2+ `atomicAdd/Sub/...` calls | WARNING |
| `__syncthreads` in branch | sync inside `if` block | CRITICAL |
| Missing shared memory | loop over global mem, no `__shared__` | WARNING |
| Missing `__restrict__` | pointer args without restrict | INFO |

---

## Validated with Nsight Compute

After running `--compare`, validate findings with:

```bash
ncu --metrics sm__warps_active.avg.pct_of_peak_sustained_active \
              l1tex__t_bytes_pipe_lsu_mem_global_op_ld.sum \
    ./gpu-analyzer --compare stencil
```

---

## Resume bullet

> Built a CUDA kernel performance analyzer detecting warp divergence, uncoalesced memory,  
> and atomic contention using static heuristics + CUDA event profiling; validated  
> 2–4× measured speedups against Nsight Compute on RTX 3050.