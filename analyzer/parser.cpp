#include "analyzer.h"
#include <fstream>
#include <sstream>
#include <iostream>
#include <regex>
#include <algorithm>

// Forward declaration from rules.cpp
std::vector<Finding> applyRules(const std::string& source);

// ─── Read file to string ───────────────────────────────────────────────────────
static std::string readFile(const std::string& path) {
    std::ifstream f(path);
    if (!f) throw std::runtime_error("Cannot open: " + path);
    return std::string(std::istreambuf_iterator<char>(f),
                       std::istreambuf_iterator<char>());
}

// ─── Extract kernel names from source ─────────────────────────────────────────
static std::vector<std::string> extractKernelNames(const std::string& src) {
    std::vector<std::string> names;
    std::regex re(R"(__global__\s+\w+\s+(\w+)\s*\()");
    auto begin = std::sregex_iterator(src.begin(), src.end(), re);
    auto end   = std::sregex_iterator();
    for (auto it = begin; it != end; ++it)
        names.push_back((*it)[1].str());
    return names;
}

// ─── Compute a score 0–100 from the findings ──────────────────────────────────
// Deductions: CRITICAL = 25, WARNING = 10, INFO = 3
static int computeScore(const std::vector<Finding>& findings) {
    int deduction = 0;
    for (auto& f : findings) {
        switch (f.severity) {
            case Severity::CRITICAL: deduction += 25; break;
            case Severity::WARNING:  deduction += 10; break;
            case Severity::INFO:     deduction +=  3; break;
        }
    }
    return std::max(0, 100 - deduction);
}

// ─── Pretty print an AnalysisResult ───────────────────────────────────────────
void printAnalysis(const AnalysisResult& r) {
    std::string bar(60, '-');
    std::cout << "\n" << bar << "\n";
    std::cout << "  Kernel: " << r.kernelName << "\n";
    std::cout << "  Score : " << r.score << "/100";
    if      (r.score >= 80) std::cout << "  ✓ Good";
    else if (r.score >= 50) std::cout << "  ⚠ Needs work";
    else                    std::cout << "  ✗ Critical issues";
    std::cout << "\n" << bar << "\n";

    if (r.findings.empty()) {
        std::cout << "  No issues detected.\n";
        return;
    }

    for (auto& f : r.findings) {
        const char* icon =
            f.severity == Severity::CRITICAL ? "  [CRITICAL]" :
            f.severity == Severity::WARNING  ? "  [WARNING] " :
                                               "  [INFO]    ";
        std::cout << icon << " " << issueStr(f.type);
        if (f.line > 0) std::cout << "  (line " << f.line << ")";
        std::cout << "\n";

        if (!f.context.empty())
            std::cout << "             Code   : " << f.context << "\n";

        // indent multiline suggestions
        std::istringstream ss(f.suggestion);
        std::string line;
        bool first = true;
        while (std::getline(ss, line)) {
            if (first) { std::cout << "             Action : " << line << "\n"; first = false; }
            else         std::cout << "                      " << line << "\n";
        }
        std::cout << "\n";
    }
}

// ─── Public: analyse a .cu file ───────────────────────────────────────────────
AnalysisResult analyzeFile(const std::string& path) {
    std::string src = readFile(path);
    auto names = extractKernelNames(src);
    std::string kname = names.empty() ? path : names[0];

    auto findings = applyRules(src);
    int  score    = computeScore(findings);

    return { kname, findings, score };
}