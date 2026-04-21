// analyzer/export.cpp — JSON serialisation for dashboard consumption
// Output format consumed by dashboard/src/

#include "analyzer.h"
#include <sstream>
#include <iomanip>
#include <fstream>
#include <iostream>

// ─── Escape a string for JSON ─────────────────────────────────────────────────
static std::string jsonStr(const std::string& s) {
    std::string out = "\"";
    for (char c : s) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:   out += c;
        }
    }
    return out + "\"";
}

// ─── Serialise a single Finding ───────────────────────────────────────────────
static std::string findingToJson(const Finding& f, int indent) {
    std::string pad(indent, ' ');
    std::string out = pad + "{\n";
    out += pad + "  \"type\": "     + jsonStr(issueStr(f.type))       + ",\n";
    out += pad + "  \"severity\": " + jsonStr(severityStr(f.severity)) + ",\n";
    out += pad + "  \"line\": "     + std::to_string(f.line)           + ",\n";
    out += pad + "  \"context\": "  + jsonStr(f.context)               + ",\n";
    out += pad + "  \"suggestion\": "+ jsonStr(f.suggestion)            + "\n";
    out += pad + "}";
    return out;
}

// ─── Serialise an AnalysisResult ──────────────────────────────────────────────
std::string analysisToJson(const AnalysisResult& r) {
    std::string out = "{\n";
    out += "  \"kernelName\": " + jsonStr(r.kernelName) + ",\n";
    out += "  \"score\": "      + std::to_string(r.score) + ",\n";
    out += "  \"findings\": [\n";
    for (size_t i = 0; i < r.findings.size(); ++i) {
        out += findingToJson(r.findings[i], 4);
        if (i + 1 < r.findings.size()) out += ",";
        out += "\n";
    }
    out += "  ]\n}";
    return out;
}

// ─── Serialise a ProfileResult ────────────────────────────────────────────────
std::string profileToJson(const ProfileResult& p) {
    std::ostringstream ss;
    ss << std::fixed << std::setprecision(4);
    std::string out = "{\n";
    out += "  \"kernelName\": "      + jsonStr(p.kernelName)                       + ",\n";
    ss.str(""); ss << p.elapsedMs;
    out += "  \"elapsedMs\": "       + ss.str()                                     + ",\n";
    ss.str(""); ss << p.occupancyPct;
    out += "  \"occupancyPct\": "    + ss.str()                                     + ",\n";
    ss.str(""); ss << p.memThroughputGBs;
    out += "  \"memThroughputGBs\": "+ ss.str()                                     + ",\n";
    out += "  \"bytesProcessed\": "  + std::to_string(p.bytesProcessed)             + ",\n";
    out += "  \"runs\": "            + std::to_string(p.runs)                       + "\n";
    out += "}";
    return out;
}

// ─── Full report: analysis + profile pairs ────────────────────────────────────
// Structure:
// {
//   "timestamp": "...",
//   "gpu": "RTX 3050",
//   "comparisons": [ { "test": "divergence", "bad": {...}, "good": {...}, "speedup": 2.4 }, ... ],
//   "analyses":    [ { "file": "...", "result": {...} }, ... ]
// }

std::string buildFullReport(
    const std::vector<std::pair<std::string, AnalysisResult>>& analyses,
    const std::vector<std::tuple<std::string, ProfileResult, ProfileResult, float>>& comparisons,
    const std::string& gpuName)
{
    std::string out = "{\n";
    out += "  \"gpu\": " + jsonStr(gpuName) + ",\n";

    // analyses
    out += "  \"analyses\": [\n";
    for (size_t i = 0; i < analyses.size(); ++i) {
        out += "    {\n";
        out += "      \"file\": " + jsonStr(analyses[i].first) + ",\n";
        out += "      \"result\": " + analysisToJson(analyses[i].second) + "\n";
        out += "    }";
        if (i + 1 < analyses.size()) out += ",";
        out += "\n";
    }
    out += "  ],\n";

    // comparisons
    out += "  \"comparisons\": [\n";
    for (size_t i = 0; i < comparisons.size(); ++i) {
        auto& [test, bad, good, speedup] = comparisons[i];
        std::ostringstream ss;
        ss << std::fixed << std::setprecision(2) << speedup;
        out += "    {\n";
        out += "      \"test\": "    + jsonStr(test)  + ",\n";
        out += "      \"bad\": "     + profileToJson(bad)  + ",\n";
        out += "      \"good\": "    + profileToJson(good) + ",\n";
        out += "      \"speedup\": " + ss.str()            + "\n";
        out += "    }";
        if (i + 1 < comparisons.size()) out += ",";
        out += "\n";
    }
    out += "  ]\n";
    out += "}\n";
    return out;
}

// ─── Write report to file ─────────────────────────────────────────────────────
void writeReport(const std::string& json, const std::string& path) {
    std::ofstream f(path);
    if (!f) throw std::runtime_error("Cannot write report to: " + path);
    f << json;
    std::cout << "[Report] Written to " << path << "\n";
}