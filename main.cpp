// main.cpp — GPU Kernel Performance Analyzer CLI
// Usage:
//   gpu-analyzer --analyze kernels/bad_kernel.cu
//   gpu-analyzer --profile stencil
//   gpu-analyzer --compare divergence
//   gpu-analyzer --all

#include "analyzer/analyzer.h"
#include <iostream>
#include <string>
#include <vector>
#include <stdexcept>

// ─── From analyzer/ ───────────────────────────────────────────────────────────
AnalysisResult analyzeFile(const std::string& path);
void           printAnalysis(const AnalysisResult&);

// ─── From profiler/ ───────────────────────────────────────────────────────────
struct CompareResult;
CompareResult runComparison(const std::string& testName, int N);
void          printComparison(const CompareResult&);

// ─────────────────────────────────────────────────────────────────────────────
static void usage() {
    std::cout << R"(
GPU Kernel Performance Analyzer
================================
Usage:
  gpu-analyzer --analyze <file.cu>       Static analysis on a CUDA source file
  gpu-analyzer --compare <test>          Profile bad vs optimised kernel
                                          tests: divergence | atomic | stencil
  gpu-analyzer --all                     Analyse all sample kernels + run all comparisons

Example:
  gpu-analyzer --analyze kernels/bad_kernel.cu
  gpu-analyzer --compare stencil
  gpu-analyzer --all
)";
}

static void runAllAnalysis() {
    for (auto& f : { "kernels/bad_kernel.cu", "kernels/good_kernel.cu" }) {
        std::cout << "\n[Analyzing] " << f << "\n";
        try {
            auto r = analyzeFile(f);
            printAnalysis(r);
        } catch (std::exception& e) {
            std::cerr << "  Error: " << e.what() << "\n";
        }
    }
}

static void runAllComparisons() {
    for (auto& t : { "divergence", "atomic", "stencil" }) {
        std::cout << "\n[Comparing] " << t << "\n";
        try {
            auto c = runComparison(t, 1 << 20);
            printComparison(c);
        } catch (std::exception& e) {
            std::cerr << "  Error: " << e.what() << "\n";
        }
    }
}

int main(int argc, char** argv) {
    if (argc < 2) { usage(); return 1; }

    std::string cmd = argv[1];

    try {
        if (cmd == "--analyze" && argc >= 3) {
            auto r = analyzeFile(argv[2]);
            printAnalysis(r);

        } else if (cmd == "--compare" && argc >= 3) {
            auto c = runComparison(argv[2], 1 << 20);
            printComparison(c);

        } else if (cmd == "--all") {
            runAllAnalysis();
            runAllComparisons();

        } else {
            usage();
            return 1;
        }
    } catch (std::exception& e) {
        std::cerr << "\n[Fatal] " << e.what() << "\n";
        return 1;
    }

    return 0;
}