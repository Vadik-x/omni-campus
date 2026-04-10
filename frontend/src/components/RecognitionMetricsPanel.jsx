import { useEffect, useMemo, useState } from "react";
import axios from "axios";

const API_BASE =
  import.meta.env.VITE_BACKEND_URL
  || import.meta.env.VITE_API_BASE
  || "http://localhost:5000";
const REFRESH_INTERVAL_MS = 5000;

function asNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function formatMilliseconds(value) {
  const numeric = asNumber(value);
  return `${numeric.toFixed(1)} ms`;
}

function formatPercent(value) {
  const numeric = asNumber(value);
  return `${numeric.toFixed(1)}%`;
}

export default function RecognitionMetricsPanel() {
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState("");

  useEffect(() => {
    let active = true;

    const fetchMetrics = async () => {
      try {
        const response = await axios.get(`${API_BASE}/api/recognition/metrics`, {
          timeout: 4500,
        });

        if (!active) {
          return;
        }

        setMetrics(response.data || null);
        setError("");
        setUpdatedAt(new Date().toISOString());
      } catch (requestError) {
        if (!active) {
          return;
        }

        setError("Recognition metrics unavailable");
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    fetchMetrics();
    const intervalId = window.setInterval(fetchMetrics, REFRESH_INTERVAL_MS);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, []);

  const summary = useMemo(() => {
    const payload = metrics || {};
    const matchLatency = payload.match_total_ms || {};
    const matchSearch = payload.match_search_ms || {};
    const confidence = payload.match_confidence_pct || {};
    const ingestToDetect = payload.ingest_to_detect_ms || {};
    const detectToMatch = payload.detect_to_match_ms || {};
    const matchToEmit = payload.match_to_emit_ms || {};
    const endToEnd = payload.end_to_end_ms || {};
    const queueWait = payload.queue_wait_ms || {};
    const queueInfo = payload.queue || {};
    const searchSpaceTemplates = payload.match_search_space_templates || {};
    const searchSpaceStudents = payload.match_search_space_students || {};
    const enrollQualityAccepted = payload.enroll_quality_accepted || {};
    const enrollQualityRejected = payload.enroll_quality_rejected || {};
    const acceptedCount = asNumber(enrollQualityAccepted.count);
    const rejectedCount = asNumber(enrollQualityRejected.count);
    const totalEnrollQualitySamples = acceptedCount + rejectedCount;
    const passRate = totalEnrollQualitySamples > 0
      ? (acceptedCount / totalEnrollQualitySamples) * 100
      : 0;

    return {
      sampleCount: asNumber(matchLatency.count),
      p95Latency: formatMilliseconds(matchLatency.p95),
      avgSearch: formatMilliseconds(matchSearch.avg),
      avgConfidence: formatPercent(confidence.avg),
      p95Confidence: formatPercent(confidence.p95),
      p95IngestToDetect: formatMilliseconds(ingestToDetect.p95),
      p95DetectToMatch: formatMilliseconds(detectToMatch.p95),
      p95MatchToEmit: formatMilliseconds(matchToEmit.p95),
      p95EndToEnd: formatMilliseconds(endToEnd.p95),
      p95QueueWait: formatMilliseconds(queueWait.p95),
      queuedFrames: asNumber(queueInfo.queued_frames),
      maxQueueDepth: asNumber(queueInfo.max_queue_depth),
      droppedFramesTotal: asNumber(queueInfo.dropped_frames_total),
      avgTemplatesScored: asNumber(searchSpaceTemplates.avg).toFixed(1),
      avgStudentsScored: asNumber(searchSpaceStudents.avg).toFixed(1),
      enrollQualityPassRate: passRate,
      enrollQualityRejectCount: rejectedCount,
    };
  }, [metrics]);

  return (
    <section className="glass-card rounded-2xl border border-white/10 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h3 className="panel-title">Recognition Metrics</h3>
          <p className="panel-kicker">Live backend latency and quality</p>
        </div>
        <span className="rounded-full border border-cyan-300/30 bg-cyan-500/10 px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-cyan-100">
          {loading ? "Loading" : "Live"}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <article className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2">
          <p className="text-[11px] uppercase tracking-wider text-slate-400">Match P95</p>
          <p className="mt-1 text-sm font-semibold text-slate-100">{summary.p95Latency}</p>
        </article>
        <article className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2">
          <p className="text-[11px] uppercase tracking-wider text-slate-400">Search Avg</p>
          <p className="mt-1 text-sm font-semibold text-slate-100">{summary.avgSearch}</p>
        </article>
        <article className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2">
          <p className="text-[11px] uppercase tracking-wider text-slate-400">Confidence Avg</p>
          <p className="mt-1 text-sm font-semibold text-emerald-200">{summary.avgConfidence}</p>
        </article>
        <article className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2">
          <p className="text-[11px] uppercase tracking-wider text-slate-400">Confidence P95</p>
          <p className="mt-1 text-sm font-semibold text-emerald-200">{summary.p95Confidence}</p>
        </article>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2">
        <article className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2">
          <p className="text-[11px] uppercase tracking-wider text-slate-400">End-to-End P95</p>
          <p className="mt-1 text-sm font-semibold text-cyan-200">{summary.p95EndToEnd}</p>
        </article>
        <article className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2">
          <p className="text-[11px] uppercase tracking-wider text-slate-400">Queue Wait P95</p>
          <p className="mt-1 text-sm font-semibold text-cyan-200">{summary.p95QueueWait}</p>
        </article>
        <article className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2">
          <p className="text-[11px] uppercase tracking-wider text-slate-400">Ingest to Detect P95</p>
          <p className="mt-1 text-sm font-semibold text-slate-100">{summary.p95IngestToDetect}</p>
        </article>
        <article className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2">
          <p className="text-[11px] uppercase tracking-wider text-slate-400">Detect to Match P95</p>
          <p className="mt-1 text-sm font-semibold text-slate-100">{summary.p95DetectToMatch}</p>
        </article>
        <article className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2">
          <p className="text-[11px] uppercase tracking-wider text-slate-400">Match to Emit P95</p>
          <p className="mt-1 text-sm font-semibold text-slate-100">{summary.p95MatchToEmit}</p>
        </article>
        <article className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2">
          <p className="text-[11px] uppercase tracking-wider text-slate-400">Queue Max / Dropped</p>
          <p className="mt-1 text-sm font-semibold text-amber-200">
            {summary.maxQueueDepth} / {summary.droppedFramesTotal}
          </p>
        </article>
        <article className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2">
          <p className="text-[11px] uppercase tracking-wider text-slate-400">ANN Templates Avg</p>
          <p className="mt-1 text-sm font-semibold text-violet-200">{summary.avgTemplatesScored}</p>
        </article>
        <article className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2">
          <p className="text-[11px] uppercase tracking-wider text-slate-400">ANN Students Avg</p>
          <p className="mt-1 text-sm font-semibold text-violet-200">{summary.avgStudentsScored}</p>
        </article>
        <article className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2">
          <p className="text-[11px] uppercase tracking-wider text-slate-400">Enroll Quality Pass</p>
          <p className="mt-1 text-sm font-semibold text-emerald-200">{summary.enrollQualityPassRate.toFixed(1)}%</p>
        </article>
        <article className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2">
          <p className="text-[11px] uppercase tracking-wider text-slate-400">Enroll Reject Count</p>
          <p className="mt-1 text-sm font-semibold text-amber-200">{summary.enrollQualityRejectCount}</p>
        </article>
      </div>

      <div className="mt-3 flex items-center justify-between text-[11px] text-slate-400">
        <span>Samples: {summary.sampleCount}</span>
        <span>Queued: {summary.queuedFrames}</span>
      </div>

      <div className="mt-1 flex items-center justify-between text-[11px] text-slate-400">
        <span>
          Updated: {updatedAt ? new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "--:--:--"}
        </span>
      </div>

      {error ? (
        <p className="mt-2 rounded-lg border border-amber-300/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">
          {error}
        </p>
      ) : null}
    </section>
  );
}
