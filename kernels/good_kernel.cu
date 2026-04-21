// good_kernel.cu — optimised equivalents of each bad_kernel pattern

#include <cuda_runtime.h>

// ─── No divergence: branchless conditional ───────────────────────────────────
__global__ void noDivergenceKernel(int* __restrict__ A,
                                    int* __restrict__ B, int N) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= N) return;

    // Branchless: both paths computed, select with multiplication
    int even = i * 2;
    int odd  = i * 3;
    int sel  = threadIdx.x & 1;       // 0 for even, 1 for odd
    A[i] = even * (1 - sel) + odd * sel;   // no warp divergence

    // Coalesced write: consecutive threads → consecutive addresses
    B[i] = A[i];
}

// ─── Warp reduction before single atomic ─────────────────────────────────────
__global__ void warpReduceKernel(int* __restrict__ counter,
                                  int* __restrict__ data, int N) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    int val = (i < N) ? data[i] : 0;

    // Warp-level reduction: 5 shuffles instead of 32 atomics
    for (int offset = 16; offset > 0; offset >>= 1)
        val += __shfl_down_sync(0xFFFFFFFF, val, offset);

    // Only lane 0 of each warp does the atomic → 32× less contention
    if ((threadIdx.x & 31) == 0)
        atomicAdd(counter, val);

    if (i < N) data[i] = data[i] * 2;
}

// ─── Shared memory tiled stencil ─────────────────────────────────────────────
#define BLOCK 256
#define HALO  4     // stencil radius

__global__ void tiledStencil(float* __restrict__ out,
                               const float* __restrict__ in, int N) {
    __shared__ float tile[BLOCK + 2 * HALO];

    int gid  = blockIdx.x * blockDim.x + threadIdx.x;
    int tid  = threadIdx.x;
    int halo = HALO;

    // Load centre + left halo
    tile[tid + halo] = (gid < N) ? in[gid] : 0.f;
    if (tid < halo) {
        int left = gid - halo;
        tile[tid] = (left >= 0) ? in[left] : 0.f;
    }
    // Right halo
    if (tid >= blockDim.x - halo) {
        int right = gid + halo;
        tile[tid + 2 * halo] = (right < N) ? in[right] : 0.f;
    }

    __syncthreads();    // all threads always hit this — no deadlock

    if (gid >= N) return;

    float sum = 0.f;
    for (int k = -halo; k <= halo; ++k)
        sum += tile[tid + halo + k];   // reads from L1 shared, not global

    out[gid] = sum / (2.f * halo + 1.f);
}

// ─── Host launchers ───────────────────────────────────────────────────────────
void launchNoDivergenceKernel(int* dA, int* dB, int N, cudaStream_t stream) {
    int threads = 256;
    int blocks  = (N + threads - 1) / threads;
    noDivergenceKernel<<<blocks, threads, 0, stream>>>(dA, dB, N);
}

void launchWarpReduceKernel(int* dCounter, int* dData, int N, cudaStream_t stream) {
    int threads = 256;
    int blocks  = (N + threads - 1) / threads;
    warpReduceKernel<<<blocks, threads, 0, stream>>>(dCounter, dData, N);
}

void launchTiledStencil(float* dOut, float* dIn, int N, cudaStream_t stream) {
    int threads = BLOCK;
    int blocks  = (N + threads - 1) / threads;
    int sharedBytes = (threads + 2 * HALO) * sizeof(float);
    tiledStencil<<<blocks, threads, sharedBytes, stream>>>(dOut, dIn, N);
}
