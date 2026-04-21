// bad_kernel.cu — intentionally poor kernel for the analyzer to dissect
// Every anti-pattern here should produce a finding.

#include <cuda_runtime.h>

// ─── Warp divergence + uncoalesced access ────────────────────────────────────
__global__ void divergentKernel(int* A, int* B, int N) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= N) return;

    // ANTI-PATTERN 1: warp divergence — half the warp takes each branch
    if (threadIdx.x % 2 == 0) {
        A[i] = i * 2;
    } else {
        A[i] = i * 3;
    }

    // ANTI-PATTERN 2: strided (uncoalesced) access — stride 8
    B[threadIdx.x * 8] = A[i];
}

// ─── Atomic contention ───────────────────────────────────────────────────────
__global__ void atomicKernel(int* counter, int* data, int N) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= N) return;

    // ANTI-PATTERN 3: every thread atomically increments the same counter
    atomicAdd(counter, 1);
    atomicAdd(counter, data[i]);   // two atomics → serialised

    data[i] = data[i] * 2;
}

// ─── Global loop, no shared memory ───────────────────────────────────────────
__global__ void naiveStencil(float* out, float* in, int N) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= N) return;

    // ANTI-PATTERN 4: reads neighbours from global memory each iteration
    float sum = 0.f;
    for (int k = -4; k <= 4; ++k) {
        int idx = i + k;
        if (idx >= 0 && idx < N)
            sum += in[idx];   // 9 global reads per thread, no caching
    }
    out[i] = sum / 9.f;
}

// ─── Host launcher (for profiler to call) ────────────────────────────────────
void launchDivergentKernel(int* dA, int* dB, int N, cudaStream_t stream) {
    int threads = 256;
    int blocks  = (N + threads - 1) / threads;
    divergentKernel<<<blocks, threads, 0, stream>>>(dA, dB, N);
}

void launchAtomicKernel(int* dCounter, int* dData, int N, cudaStream_t stream) {
    int threads = 256;
    int blocks  = (N + threads - 1) / threads;
    atomicKernel<<<blocks, threads, 0, stream>>>(dCounter, dData, N);
}

void launchNaiveStencil(float* dOut, float* dIn, int N, cudaStream_t stream) {
    int threads = 256;
    int blocks  = (N + threads - 1) / threads;
    naiveStencil<<<blocks, threads, 0, stream>>>(dOut, dIn, N);
}
