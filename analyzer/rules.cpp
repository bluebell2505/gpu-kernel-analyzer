#include "analyzer.h"
#include <regex>
#include <sstream>
#include <iostream>

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Split source into lines for per-line checks
static std::vector<std::string> splitLines(const std::string& src) {
    std::vector<std::string> lines;
    std::istringstream ss(src);
    std::string line;
    while (std::getline(ss, line)) lines.push_back(line);
    return lines;
}

// Strip single-line comments so // patterns don't fire on comments
static std::string stripComments(const std::string& src) {
    std::string out;
    bool inComment = false;
    for (size_t i = 0; i < src.size(); ++i) {
        if (!inComment && i + 1 < src.size() && src[i] == '/' && src[i+1] == '/') {
            // skip to end of line
            while (i < src.size() && src[i] != '\n') ++i;
            out += '\n';
            --i;
        } else {
            out += src[i];
        }
    }
    return out;
}

// ─── Rule: Warp Divergence ────────────────────────────────────────────────────
// Look for if/switch on expressions involving threadIdx (warp-level predication)
static void checkWarpDivergence(const std::vector<std::string>& lines,
                                 std::vector<Finding>& out) {
    // Pattern: if(...threadIdx... % ...) or switch(threadIdx...)
    std::regex divRe(R"(\b(if|switch)\s*\([^)]*threadIdx\s*\.\s*[xyz][^)]*%[^)]*\))");
    for (int i = 0; i < (int)lines.size(); ++i) {
        if (std::regex_search(lines[i], divRe)) {
            out.push_back({
                IssueType::WARP_DIVERGENCE,
                Severity::CRITICAL,
                i + 1,
                lines[i],
                "Threads in the same warp take different branches → SIMT serialisation.\n"
                "  → Restructure so all 32 threads in a warp take the same path.\n"
                "  → E.g. precompute a bitmask and use branchless select()."
            });
        }
    }
    // Also flag threadIdx.x % 2, % 4, % 8 in any context
    std::regex modRe(R"(threadIdx\s*\.\s*[xyz]\s*%\s*\d+)");
    for (int i = 0; i < (int)lines.size(); ++i) {
        if (std::regex_search(lines[i], modRe)) {
            // avoid double-report lines already caught above
            bool alreadyReported = false;
            for (auto& f : out)
                if (f.line == i + 1 && f.type == IssueType::WARP_DIVERGENCE) { alreadyReported = true; break; }
            if (!alreadyReported) {
                out.push_back({
                    IssueType::WARP_DIVERGENCE,
                    Severity::WARNING,
                    i + 1,
                    lines[i],
                    "threadIdx modulo used for data selection — potential divergence.\n"
                    "  → Prefer warp-uniform predicates."
                });
            }
        }
    }
}

// ─── Rule: Uncoalesced Global Memory ─────────────────────────────────────────
// A[threadIdx.x * STRIDE] where STRIDE != 1 is uncoalesced
static void checkUncoalescedMemory(const std::vector<std::string>& lines,
                                    std::vector<Finding>& out) {
    // Look for array[threadIdx.x * <literal>] where literal > 1
    std::regex strideRe(R"(\w+\s*\[\s*threadIdx\s*\.\s*[xyz]\s*\*\s*(\d+))");
    std::smatch m;
    for (int i = 0; i < (int)lines.size(); ++i) {
        std::string copy = lines[i];
        if (std::regex_search(copy, m, strideRe)) {
            int stride = std::stoi(m[1].str());
            if (stride > 1) {
                out.push_back({
                    IssueType::UNCOALESCED_MEMORY,
                    Severity::CRITICAL,
                    i + 1,
                    lines[i],
                    "Stride-" + std::to_string(stride) + " access detected.\n"
                    "  → Consecutive threads should access consecutive addresses.\n"
                    "  → Consider transposing data layout (AoS → SoA) or tiling with shared mem."
                });
            }
        }
    }
}

// ─── Rule: Atomic Contention ──────────────────────────────────────────────────
static void checkAtomicContention(const std::vector<std::string>& lines,
                                   std::vector<Finding>& out) {
    std::regex atomRe(R"(\batomic(Add|Sub|Exch|Max|Min|And|Or|Xor|CAS)\s*\()");
    int atomicCount = 0;
    std::vector<int> atomicLines;
    for (int i = 0; i < (int)lines.size(); ++i) {
        if (std::regex_search(lines[i], atomRe)) {
            ++atomicCount;
            atomicLines.push_back(i + 1);
        }
    }
    if (atomicCount >= 2) {
        out.push_back({
            IssueType::ATOMIC_CONTENTION,
            Severity::WARNING,
            atomicLines[0],
            "Multiple atomic operations (" + std::to_string(atomicCount) + " found)",
            "Multiple atomics → serialised writes, kills parallelism.\n"
            "  → Use warp-level reduction (__reduce_add_sync) then one atomic per warp.\n"
            "  → Or use CUB/Thrust block-reduce before the final atomic."
        });
    } else if (atomicCount == 1) {
        out.push_back({
            IssueType::ATOMIC_CONTENTION,
            Severity::INFO,
            atomicLines[0],
            "One atomic found",
            "Atomic is fine here, but if inside a loop consider warp reduction first."
        });
    }
}

// ─── Rule: __syncthreads() Inside Branch ─────────────────────────────────────
// This is a GPU deadlock pattern — all threads must hit syncthreads
static void checkSyncInBranch(const std::vector<std::string>& lines,
                                std::vector<Finding>& out) {
    bool inBranch = false;
    int braceDepth = 0;
    int ifBraceDepth = -1;

    for (int i = 0; i < (int)lines.size(); ++i) {
        // Simple heuristic: track if-blocks containing __syncthreads
        bool hasIf = std::regex_search(lines[i], std::regex(R"(\bif\s*\()"));
        bool hasSync = lines[i].find("__syncthreads") != std::string::npos;

        for (char c : lines[i]) {
            if (c == '{') { ++braceDepth; if (hasIf) { inBranch = true; ifBraceDepth = braceDepth; } }
            if (c == '}') { if (braceDepth == ifBraceDepth) { inBranch = false; ifBraceDepth = -1; } --braceDepth; }
        }

        if (inBranch && hasSync) {
            out.push_back({
                IssueType::SYNCTHREADS_IN_BRANCH,
                Severity::CRITICAL,
                i + 1,
                lines[i],
                "__syncthreads() inside conditional: threads that don't enter\n"
                "  the branch will deadlock the entire block.\n"
                "  → Ensure ALL threads in a block reach the same __syncthreads() call."
            });
        }
    }
}

// ─── Rule: Missing Shared Memory ─────────────────────────────────────────────
// Heuristic: kernel reads from global array in a loop with no __shared__ usage
static void checkMissingSharedMem(const std::string& src,
                                   std::vector<Finding>& out) {
    bool hasShared = src.find("__shared__") != std::string::npos;
    bool hasLoop   = std::regex_search(src, std::regex(R"(\b(for|while)\s*\()"));
    // Has global pointer param + loop but no shared
    bool hasGlobalRead = std::regex_search(src, std::regex(R"(\w+\s*\[\s*(blockIdx|threadIdx))"));

    if (!hasShared && hasLoop && hasGlobalRead) {
        out.push_back({
            IssueType::NO_SHARED_MEM,
            Severity::WARNING,
            -1,
            "Loop over global memory, no __shared__ found",
            "Repeated global memory reads in a loop are expensive (480GB/s vs 19TB/s shared).\n"
            "  → Load a tile into shared memory once, synchronise, compute from shared.\n"
            "  → Classic pattern: tiled matrix multiply, stencil kernels."
        });
    }
}

// ─── Rule: Missing __restrict__ ──────────────────────────────────────────────
static void checkMissingRestrict(const std::string& src,
                                  std::vector<Finding>& out) {
    // Find __global__ function signature
    std::regex globalRe(R"(__global__[^(]+\(([^)]+)\))");
    std::smatch m;
    std::string copy = src;
    while (std::regex_search(copy, m, globalRe)) {
        std::string params = m[1].str();
        // Has pointer but no __restrict__?
        bool hasPtr      = params.find('*') != std::string::npos;
        bool hasRestrict = params.find("__restrict__") != std::string::npos;
        if (hasPtr && !hasRestrict) {
            out.push_back({
                IssueType::MISSING_RESTRICT,
                Severity::INFO,
                -1,
                params,
                "Pointer args without __restrict__: compiler assumes aliasing → fewer opts.\n"
                "  → Add __restrict__ to non-aliased pointers: float* __restrict__ A"
            });
        }
        copy = m.suffix().str();
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────
std::vector<Finding> applyRules(const std::string& source) {
    std::vector<Finding> findings;
    std::string clean = stripComments(source);
    auto lines = splitLines(clean);

    checkWarpDivergence(lines, findings);
    checkUncoalescedMemory(lines, findings);
    checkAtomicContention(lines, findings);
    checkSyncInBranch(lines, findings);
    checkMissingSharedMem(clean, findings);
    checkMissingRestrict(clean, findings);

    return findings;
}