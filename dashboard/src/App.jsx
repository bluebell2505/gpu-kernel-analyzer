import { useState, useEffect, useRef } from "react";

// ─── Embedded sample data (mirrors dashboard/sample_report.json) ──────────────
const SAMPLE = {
  gpu: "NVIDIA RTX 3050 (Ampere, sm_86, 2048 CUDA cores, 4GB GDDR6)",
  analyses: [
    {
      file: "kernels/bad_kernel.cu",
      result: {
        kernelName: "divergentKernel",
        score: 21,
        findings: [
          { type: "Warp divergence", severity: "CRITICAL", line: 16, context: "if (threadIdx.x % 2 == 0) {", suggestion: "Threads in the same warp take different branches → SIMT serialisation. Restructure so all 32 threads take the same path. Use branchless select()." },
          { type: "Uncoalesced memory access", severity: "CRITICAL", line: 24, context: "B[threadIdx.x * 8] = A[i];", suggestion: "Stride-8 access detected. Consecutive threads must access consecutive addresses. Consider AoS → SoA or shared memory tiling." },
          { type: "Atomic contention", severity: "WARNING", line: 35, context: "atomicAdd(counter, ...)", suggestion: "Multiple atomics → serialised writes. Use warp-level reduction then one atomic per warp." },
          { type: "Missing shared memory", severity: "WARNING", line: -1, context: "Loop over global memory, no __shared__ found", suggestion: "Global memory reads in a loop are expensive. Load a tile into shared memory once, sync, compute from L1." },
          { type: "Missing __restrict__", severity: "INFO", line: -1, context: "int* A, int* B, int N", suggestion: "Compiler assumes pointer aliasing. Add __restrict__ for better auto-vectorisation." },
        ],
      },
    },
    {
      file: "kernels/good_kernel.cu",
      result: {
        kernelName: "noDivergenceKernel",
        score: 97,
        findings: [
          { type: "Atomic contention", severity: "INFO", line: 42, context: "atomicAdd — one call", suggestion: "Single atomic is fine. If inside a hot loop, consider warp reduction first." },
        ],
      },
    },
  ],
  comparisons: [
    { test: "divergence", bad: { kernelName: "divergentKernel", elapsedMs: 0.824, occupancyPct: 62.5, memThroughputGBs: 9.14, bytesProcessed: 8388608, runs: 100 }, good: { kernelName: "noDivergenceKernel", elapsedMs: 0.312, occupancyPct: 100, memThroughputGBs: 24.19, bytesProcessed: 8388608, runs: 100 }, speedup: 2.64 },
    { test: "atomic",     bad: { kernelName: "atomicKernel",     elapsedMs: 1.945, occupancyPct: 50,   memThroughputGBs: 2.31,  bytesProcessed: 4194304, runs: 100 }, good: { kernelName: "warpReduceKernel",  elapsedMs: 0.418, occupancyPct: 100, memThroughputGBs: 10.76, bytesProcessed: 4194304, runs: 100 }, speedup: 4.65 },
    { test: "stencil",    bad: { kernelName: "naiveStencil",     elapsedMs: 2.371, occupancyPct: 75,   memThroughputGBs: 15.06, bytesProcessed: 33554432, runs: 100 }, good: { kernelName: "tiledStencil",      elapsedMs: 0.785, occupancyPct: 100, memThroughputGBs: 45.49, bytesProcessed: 33554432, runs: 100 }, speedup: 3.02 },
  ],
};

// ─── Constants ────────────────────────────────────────────────────────────────
const SEV_COLOR = { CRITICAL: "#f87171", WARNING: "#fbbf24", INFO: "#60a5fa" };
const SEV_BG    = { CRITICAL: "rgba(248,113,113,0.1)", WARNING: "rgba(251,191,36,0.1)", INFO: "rgba(96,165,250,0.1)" };
const PEAK_BW   = 192; // RTX 3050 peak GB/s

// ─── Mini bar chart (inline SVG) ─────────────────────────────────────────────
function Bar({ value, max, color, label, unit }) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#94a3b8", marginBottom: 3 }}>
        <span>{label}</span>
        <span style={{ color: "#e2e8f0", fontVariantNumeric: "tabular-nums" }}>{value.toFixed(2)}{unit}</span>
      </div>
      <div style={{ background: "#1e293b", borderRadius: 3, height: 6, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 3, transition: "width 0.6s cubic-bezier(0.16,1,0.3,1)" }} />
      </div>
    </div>
  );
}

// ─── Score ring ───────────────────────────────────────────────────────────────
function ScoreRing({ score }) {
  const size = 58;
  const r = 24;          // reduced radius
  const stroke = 4;
  const center = size / 2;

  const circ = 2 * Math.PI * r;
  const dash = circ * (score / 100);
  const col = score >= 80 ? "#34d399" : score >= 50 ? "#fbbf24" : "#f87171";

  return (
    <svg width={size} height={size} style={{ flexShrink: 0 }}>
      <circle
        cx={center}
        cy={center}
        r={r}
        fill="none"
        stroke="#1e293b"
        strokeWidth={stroke}
      />
      <circle
        cx={center}
        cy={center}
        r={r}
        fill="none"
        stroke={col}
        strokeWidth={stroke}
        strokeDasharray={`${dash} ${circ}`}
        strokeLinecap="round"
        transform={`rotate(-90 ${center} ${center})`}
        style={{ transition: "stroke-dasharray 0.8s cubic-bezier(0.16,1,0.3,1)" }}
      />
      <text
        x={center}
        y={center + 4}
        textAnchor="middle"
        fontSize={12}
        fontWeight={700}
        fill={col}
        fontFamily="'JetBrains Mono', monospace"
      >
        {score}
      </text>
    </svg>
  );
}

// ─── Timeline bar (comparison) ────────────────────────────────────────────────
function TimelineRow({ comp, maxMs }) {
  const badW  = (comp.bad.elapsedMs  / maxMs) * 100;
  const goodW = (comp.good.elapsedMs / maxMs) * 100;
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontFamily: "monospace", color: "#94a3b8", width: 72, textAlign: "right" }}>{comp.test}</span>
        <span style={{ fontSize: 11, color: "#34d399", background: "rgba(52,211,153,0.12)", borderRadius: 4, padding: "1px 7px", fontWeight: 700 }}>
          {comp.speedup.toFixed(2)}×
        </span>
      </div>
      {/* bad */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span style={{ width: 72, fontSize: 10, color: "#64748b", textAlign: "right" }}>bad</span>
        <div style={{ flex: 1, background: "#0f172a", borderRadius: 3, height: 22, overflow: "hidden", position: "relative" }}>
          <div style={{ width: `${badW}%`, height: "100%", background: "linear-gradient(90deg,#7f1d1d,#f87171)", borderRadius: 3, transition: "width 0.7s cubic-bezier(0.16,1,0.3,1)", display: "flex", alignItems: "center" }}>
            <span style={{ fontSize: 10, color: "#fff", paddingLeft: 8, whiteSpace: "nowrap", opacity: badW > 18 ? 1 : 0 }}>{comp.bad.elapsedMs.toFixed(3)} ms</span>
          </div>
          {badW <= 18 && <span style={{ fontSize: 10, color: "#f87171", position: "absolute", left: `calc(${badW}% + 6px)`, top: 4 }}>{comp.bad.elapsedMs.toFixed(3)} ms</span>}
        </div>
      </div>
      {/* good */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 72, fontSize: 10, color: "#64748b", textAlign: "right" }}>optimised</span>
        <div style={{ flex: 1, background: "#0f172a", borderRadius: 3, height: 22, overflow: "hidden", position: "relative" }}>
          <div style={{ width: `${goodW}%`, height: "100%", background: "linear-gradient(90deg,#064e3b,#34d399)", borderRadius: 3, transition: "width 0.7s cubic-bezier(0.16,1,0.3,1) 0.1s", display: "flex", alignItems: "center" }}>
            <span style={{ fontSize: 10, color: "#fff", paddingLeft: 8, whiteSpace: "nowrap", opacity: goodW > 18 ? 1 : 0 }}>{comp.good.elapsedMs.toFixed(3)} ms</span>
          </div>
          {goodW <= 18 && <span style={{ fontSize: 10, color: "#34d399", position: "absolute", left: `calc(${goodW}% + 6px)`, top: 4 }}>{comp.good.elapsedMs.toFixed(3)} ms</span>}
        </div>
      </div>
    </div>
  );
}

// ─── Finding card ─────────────────────────────────────────────────────────────
function FindingCard({ f, idx }) {
  const [open, setOpen] = useState(false);
  return (
    <div onClick={() => setOpen(o => !o)} style={{ cursor: "pointer", borderLeft: `3px solid ${SEV_COLOR[f.severity]}`, background: open ? SEV_BG[f.severity] : "rgba(255,255,255,0.02)", borderRadius: "0 6px 6px 0", padding: "10px 12px", marginBottom: 6, transition: "background 0.2s" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: SEV_COLOR[f.severity], textTransform: "uppercase", letterSpacing: 1, flexShrink: 0 }}>{f.severity}</span>
        <span style={{ fontSize: 12, color: "#e2e8f0", flex: 1 }}>{f.type}</span>
        {f.line > 0 && <span style={{ fontSize: 10, color: "#475569", fontFamily: "monospace" }}>L{f.line}</span>}
        <span style={{ fontSize: 10, color: "#475569" }}>{open ? "▲" : "▼"}</span>
      </div>
      {open && (
        <div style={{ marginTop: 8 }}>
          {f.context && <div style={{ fontFamily: "monospace", fontSize: 11, color: "#7dd3fc", background: "#0f172a", borderRadius: 4, padding: "6px 10px", marginBottom: 6 }}>{f.context}</div>}
          <div style={{ fontSize: 11, color: "#94a3b8", lineHeight: 1.6 }}>{f.suggestion}</div>
        </div>
      )}
    </div>
  );
}

// ─── Occupancy + BW scatter (mini SVG chart) ──────────────────────────────────
function ScatterChart({ comparisons }) {
  const W = 280, H = 160, PAD = 30;
  const pts = comparisons.flatMap(c => [
    { label: c.bad.kernelName, occ: c.bad.occupancyPct, bw: c.bad.memThroughputGBs, bad: true, test: c.test },
    { label: c.good.kernelName, occ: c.good.occupancyPct, bw: c.good.memThroughputGBs, bad: false, test: c.test },
  ]);
  const maxBW  = PEAK_BW;
  const xScale = x => PAD + (x / 100) * (W - PAD * 2);
  const yScale = y => (H - PAD) - (y / maxBW) * (H - PAD * 2);

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`}>
      {/* grid */}
      {[0,25,50,75,100].map(v => (
        <line key={v} x1={xScale(v)} y1={PAD} x2={xScale(v)} y2={H-PAD} stroke="#1e293b" strokeWidth={0.5} />
      ))}
      {[0,50,100,150,192].map(v => (
        <line key={v} x1={PAD} y1={yScale(v)} x2={W-PAD} y2={yScale(v)} stroke="#1e293b" strokeWidth={0.5} />
      ))}
      {/* axis labels */}
      <text x={W/2} y={H-2} textAnchor="middle" fontSize={8} fill="#475569">Occupancy %</text>
      <text x={8} y={H/2} textAnchor="middle" fontSize={8} fill="#475569" transform={`rotate(-90,8,${H/2})`}>GB/s</text>
      {/* peak BW line */}
      <line x1={PAD} y1={yScale(PEAK_BW)} x2={W-PAD} y2={yScale(PEAK_BW)} stroke="#fbbf24" strokeWidth={0.5} strokeDasharray="3 3" />
      <text x={W-PAD+2} y={yScale(PEAK_BW)+3} fontSize={7} fill="#fbbf24">peak</text>
      {/* points */}
      {pts.map((p, i) => (
        <g key={i}>
          <circle cx={xScale(p.occ)} cy={yScale(p.bw)} r={4}
            fill={p.bad ? "#f87171" : "#34d399"} opacity={0.85} />
          <text x={xScale(p.occ)+6} y={yScale(p.bw)+3} fontSize={7} fill="#94a3b8">{p.test}{p.bad?"":" ✓"}</text>
        </g>
      ))}
      {/* legend */}
      <circle cx={PAD+4} cy={H-PAD+14} r={3} fill="#f87171" />
      <text x={PAD+10} y={H-PAD+17} fontSize={7} fill="#94a3b8">bad</text>
      <circle cx={PAD+32} cy={H-PAD+14} r={3} fill="#34d399" />
      <text x={PAD+38} y={H-PAD+17} fontSize={7} fill="#94a3b8">optimised</text>
    </svg>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [data] = useState(SAMPLE);
  const [activeTab, setActiveTab] = useState("timeline");
  const [selectedKernel, setSelectedKernel] = useState(0);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setTimeout(() => setMounted(true), 80); }, []);

  const maxMs = Math.max(...data.comparisons.map(c => c.bad.elapsedMs));
  const analysis = data.analyses[selectedKernel];

  const tabs = ["timeline", "metrics", "findings"];

  return (
    <div style={{ fontFamily: "'JetBrains Mono', 'Fira Code', monospace", background: "#020817", minHeight: "100vh", color: "#e2e8f0", padding: 0 }}>
      {/* Google Font */}
      <style>{`@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Space+Grotesk:wght@400;500;700&display=swap');
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-track { background: #0f172a; } ::-webkit-scrollbar-thumb { background: #334155; border-radius: 2px; }
      `}</style>

      {/* Header */}
      <div style={{ borderBottom: "1px solid #1e293b", padding: "14px 24px", display: "flex", alignItems: "center", gap: 12, background: "#020817" }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#34d399", boxShadow: "0 0 8px #34d399" }} />
        <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 15, letterSpacing: 1, color: "#f8fafc" }}>GPU KERNEL ANALYZER</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: "#475569" }}>{data.gpu}</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(260px, 320px) 1fr", minHeight: "calc(100vh - 49px)" }}>

        {/* ── Left sidebar: kernel list ─────────────────────────────────────── */}
        <div style={{ borderRight: "1px solid #1e293b", padding: 16, background: "#020817" }}>
          <div style={{ fontSize: 9, letterSpacing: 2, color: "#475569", marginBottom: 12, fontWeight: 700 }}>KERNELS</div>
          {data.analyses.map((a, i) => (
            <div key={i} onClick={() => setSelectedKernel(i)}
              style={{ cursor: "pointer", borderRadius: 6, padding: "10px 12px", marginBottom: 8,
                background: selectedKernel === i ? "#0f172a" : "transparent",
                border: selectedKernel === i ? "1px solid #1e293b" : "1px solid transparent",
                transition: "all 0.15s" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
                <ScoreRing score={a.result.score} />
                <div>
                  <div style={{ fontSize: 13, letterSpacing: 0.3, color: "#f8fafc", fontWeight: 700 }}>{a.result.kernelName}</div>
                  <div style={{ fontSize: 9, color: "#475569", marginTop: 2 }}>{a.file.split("/").pop()}</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
                {["CRITICAL","WARNING","INFO"].map(sev => {
                  const count = a.result.findings.filter(f => f.severity === sev).length;
                  if (!count) return null;
                  return <span key={sev} style={{ fontSize: 9, color: SEV_COLOR[sev], background: SEV_BG[sev], borderRadius: 3, padding: "1px 5px" }}>{count} {sev.toLowerCase()}</span>;
                })}
              </div>
            </div>
          ))}

          {/* Comparison summary */}
          <div style={{ marginTop: 24 }}>
            <div style={{ fontSize: 9, letterSpacing: 2, color: "#475569", marginBottom: 12, fontWeight: 700 }}>SPEEDUPS</div>
            {data.comparisons.map((c, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #0f172a" }}>
                <span style={{ fontSize: 10, color: "#64748b" }}>{c.test}</span>
                <span style={{ fontSize: 10, color: "#34d399", fontWeight: 700 }}>{c.speedup.toFixed(2)}×</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── Main panel ───────────────────────────────────────────────────── */}
        <div style={{
          padding: "28px 40px",
          overflow: "auto",
          width: "100%",
          maxWidth: "1400px",
          margin: "0 auto"
        }}>

          {/* Tabs */}
          <div style={{ display: "flex", gap: 2, marginBottom: 24, background: "#0f172a", borderRadius: 8, padding: 3, width: "fit-content" }}>
            {tabs.map(t => (
              <button key={t} onClick={() => setActiveTab(t)} style={{ cursor: "pointer", border: "none", borderRadius: 6, padding: "6px 16px", fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", fontFamily: "inherit", background: activeTab === t ? "#1e293b" : "transparent", color: activeTab === t ? "#f8fafc" : "#475569", transition: "all 0.15s" }}>
                {t}
              </button>
            ))}
          </div>

          {/* ── TAB: Timeline ──────────────────────────────────────────────── */}
          {activeTab === "timeline" && (
            <div style={{ opacity: mounted ? 1 : 0, transition: "opacity 0.4s" }}>
              <div style={{ fontSize: 9, letterSpacing: 2, color: "#475569", marginBottom: 16, fontWeight: 700 }}>EXECUTION TIMELINE — BAD vs OPTIMISED</div>
              <div style={{ background: "#0a0f1e", border: "1px solid #1e293b", borderRadius: 10, padding: 20, marginBottom: 24 }}>
                {data.comparisons.map((c, i) => <TimelineRow key={i} comp={c} maxMs={maxMs} />)}
              </div>

              {/* Scatter */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <div style={{ background: "#0a0f1e", border: "1px solid #1e293b", borderRadius: 10, padding: 16 }}>
                  <div style={{ fontSize: 9, letterSpacing: 2, color: "#475569", marginBottom: 12, fontWeight: 700 }}>OCCUPANCY vs BANDWIDTH</div>
                  <ScatterChart comparisons={data.comparisons} />
                </div>
                <div style={{ background: "#0a0f1e", border: "1px solid #1e293b", borderRadius: 10, padding: 16 }}>
                  <div style={{ fontSize: 9, letterSpacing: 2, color: "#475569", marginBottom: 12, fontWeight: 700 }}>TOTAL SPEEDUP BY TEST</div>
                  {data.comparisons.map((c, i) => {
                    const w = (c.speedup / 5) * 100;
                    return (
                      <div key={i} style={{ marginBottom: 12 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#94a3b8", marginBottom: 4 }}>
                          <span>{c.test}</span><span style={{ color: "#34d399", fontWeight: 700 }}>{c.speedup.toFixed(2)}×</span>
                        </div>
                        <div style={{ background: "#1e293b", borderRadius: 3, height: 8 }}>
                          <div style={{ width: `${w}%`, height: "100%", background: `linear-gradient(90deg,#064e3b,#34d399)`, borderRadius: 3 }} />
                        </div>
                      </div>
                    );
                  })}
                  <div style={{ marginTop: 16, fontSize: 10, color: "#475569" }}>
                    Best: <span style={{ color: "#34d399" }}>atomic ({data.comparisons.find(c=>c.test==="atomic")?.speedup.toFixed(2)}×)</span> — warp reduction over 2 atomics/thread
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── TAB: Metrics ───────────────────────────────────────────────── */}
          {activeTab === "metrics" && (
            <div style={{ opacity: mounted ? 1 : 0, transition: "opacity 0.4s" }}>
              <div style={{ fontSize: 9, letterSpacing: 2, color: "#475569", marginBottom: 16, fontWeight: 700 }}>KERNEL METRICS — {analysis.result.kernelName.toUpperCase()}</div>
              {data.comparisons.map((c, i) => (
                <div key={i} style={{ background: "#0a0f1e", border: "1px solid #1e293b", borderRadius: 10, padding: 16, marginBottom: 16 }}>
                  <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 14, fontWeight: 700, borderBottom: "1px solid #1e293b", paddingBottom: 8 }}>
                    {c.test} <span style={{ color: "#34d399", fontSize: 10 }}>({c.speedup.toFixed(2)}× speedup)</span>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
                    <div>
                      <div style={{ fontSize: 9, color: "#f87171", letterSpacing: 1, marginBottom: 8, fontWeight: 700 }}>BAD — {c.bad.kernelName}</div>
                      <Bar value={c.bad.elapsedMs}        max={maxMs}   color="#f87171" label="Elapsed (ms)"   unit=" ms" />
                      <Bar value={c.bad.occupancyPct}     max={100}     color="#f87171" label="Occupancy"      unit="%" />
                      <Bar value={c.bad.memThroughputGBs} max={PEAK_BW} color="#f87171" label="Mem throughput" unit=" GB/s" />
                    </div>
                    <div>
                      <div style={{ fontSize: 9, color: "#34d399", letterSpacing: 1, marginBottom: 8, fontWeight: 700 }}>OPTIMISED — {c.good.kernelName}</div>
                      <Bar value={c.good.elapsedMs}        max={maxMs}   color="#34d399" label="Elapsed (ms)"   unit=" ms" />
                      <Bar value={c.good.occupancyPct}     max={100}     color="#34d399" label="Occupancy"      unit="%" />
                      <Bar value={c.good.memThroughputGBs} max={PEAK_BW} color="#34d399" label="Mem throughput" unit=" GB/s" />
                    </div>
                  </div>
                  <div style={{ marginTop: 12, fontSize: 10, color: "#475569", display: "flex", gap: 16 }}>
                    <span>Data moved: {(c.bad.bytesProcessed/1024/1024).toFixed(0)} MB</span>
                    <span>Runs: {c.bad.runs}</span>
                    <span>BW util (good): <span style={{ color: "#34d399" }}>{(c.good.memThroughputGBs/PEAK_BW*100).toFixed(1)}%</span></span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── TAB: Findings ──────────────────────────────────────────────── */}
          {activeTab === "findings" && (
            <div style={{ opacity: mounted ? 1 : 0, transition: "opacity 0.4s" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20 }}>
                <div style={{ fontSize: 9, letterSpacing: 2, color: "#475569", fontWeight: 700 }}>STATIC ANALYSIS — {analysis.result.kernelName.toUpperCase()}</div>
                <div style={{ flex: 1 }} />
                <ScoreRing score={analysis.result.score} />
                <div>
                  <div style={{ fontSize: 10, color: "#94a3b8" }}>Health score</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: analysis.result.score >= 80 ? "#34d399" : analysis.result.score >= 50 ? "#fbbf24" : "#f87171" }}>{analysis.result.score}<span style={{ fontSize: 12, color: "#475569" }}>/100</span></div>
                </div>
              </div>

              {/* severity summary */}
              <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
                {["CRITICAL","WARNING","INFO"].map(sev => {
                  const n = analysis.result.findings.filter(f=>f.severity===sev).length;
                  return (
                    <div key={sev} style={{ flex:1, background: SEV_BG[sev], border: `1px solid ${SEV_COLOR[sev]}22`, borderRadius: 8, padding: "12px 14px" }}>
                      <div style={{ fontSize: 20, fontWeight: 700, color: SEV_COLOR[sev] }}>{n}</div>
                      <div style={{ fontSize: 9, color: SEV_COLOR[sev], letterSpacing: 1, marginTop: 2 }}>{sev}</div>
                    </div>
                  );
                })}
              </div>

              {/* findings list */}
              {analysis.result.findings.map((f, i) => <FindingCard key={i} f={f} idx={i} />)}

              {analysis.result.findings.length === 0 && (
                <div style={{ textAlign: "center", padding: 40, color: "#34d399" }}>No issues detected</div>
              )}

              {/* switch kernel note */}
              <div style={{ marginTop: 20, fontSize: 10, color: "#334155" }}>
                Switch kernels in the left panel to compare bad vs optimised analysis.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}