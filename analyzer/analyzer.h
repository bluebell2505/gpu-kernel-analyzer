#pragma once
#include <string>
#include <vector>

// ─── Severity ─────────────────────────────────────────────────────────────────
enum class Severity { INFO, WARNING, CRITICAL };

inline const char* severityStr(Severity s) {
    switch (s) {
        case Severity::INFO:     return "INFO";
        case Severity::WARNING:  return "WARNING";
        case Severity::CRITICAL: return "CRITICAL";
    }
    return "UNKNOWN";
}

// ─── Issue types the analyzer can detect ──────────────────────────────────────
enum class IssueType {
    WARP_DIVERGENCE,        // if (threadIdx.x % N) style conditionals
    UNCOALESCED_MEMORY,     // stride != 1 global memory access
    ATOMIC_CONTENTION,      // atomicAdd/atomicMax in hot loop
    SHARED_MEM_BANK_CONFLICT,// shared mem indexed with same bank stride
    REGISTER_PRESSURE,      // too many local variables → spilling
    SYNCTHREADS_IN_BRANCH,  // __syncthreads() inside conditional = deadlock
    NO_SHARED_MEM,          // kernel does repeated global reads (could cache)
    LARGE_THREAD_BLOCK,     // blockDim > 512 rarely helps, 1024 is limit
    MISSING_RESTRICT,       // pointer args without __restrict__ hint
};

inline const char* issueStr(IssueType t) {
    switch (t) {
        case IssueType::WARP_DIVERGENCE:         return "Warp divergence";
        case IssueType::UNCOALESCED_MEMORY:      return "Uncoalesced memory access";
        case IssueType::ATOMIC_CONTENTION:       return "Atomic contention";
        case IssueType::SHARED_MEM_BANK_CONFLICT:return "Shared memory bank conflict";
        case IssueType::REGISTER_PRESSURE:       return "Register pressure (possible spilling)";
        case IssueType::SYNCTHREADS_IN_BRANCH:   return "__syncthreads() inside branch (deadlock risk)";
        case IssueType::NO_SHARED_MEM:           return "Missing shared memory usage";
        case IssueType::LARGE_THREAD_BLOCK:      return "Excessively large thread block";
        case IssueType::MISSING_RESTRICT:        return "Missing __restrict__ on pointer args";
    }
    return "Unknown issue";
}

// ─── A single detected finding ────────────────────────────────────────────────
struct Finding {
    IssueType   type;
    Severity    severity;
    int         line;           // 1-based, -1 = whole kernel
    std::string context;        // snippet or extra info
    std::string suggestion;     // what to do about it
};

// ─── Full analysis result for one kernel ──────────────────────────────────────
struct AnalysisResult {
    std::string           kernelName;
    std::vector<Finding>  findings;
    int                   score;    // 0–100, higher = better
};

// ─── Runtime profile for one kernel ───────────────────────────────────────────
struct ProfileResult {
    std::string kernelName;
    float       elapsedMs;       // wall time for N runs, averaged
    float       occupancyPct;    // theoretical occupancy (0–100)
    float       memThroughputGBs;// estimated GB/s
    long long   bytesProcessed;  // caller fills this in
    int         runs;
};