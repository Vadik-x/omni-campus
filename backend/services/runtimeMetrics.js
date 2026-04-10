const MAX_RECENT_METRICS = Math.max(
  20,
  Math.min(1000, Number(process.env.OMNI_RECENT_METRICS_SIZE || 100))
);

const buffer = new Array(MAX_RECENT_METRICS);
let bufferWriteIndex = 0;
let bufferCount = 0;
let lastDetectionTime = null;

function asNumberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function push(entry) {
  buffer[bufferWriteIndex] = entry;
  bufferWriteIndex = (bufferWriteIndex + 1) % MAX_RECENT_METRICS;
  bufferCount = Math.min(bufferCount + 1, MAX_RECENT_METRICS);
}

function normalizeEntry(input = {}) {
  const timestamp = input.timestamp ? new Date(input.timestamp) : new Date();

  return {
    timestamp: Number.isNaN(timestamp.getTime())
      ? new Date().toISOString()
      : timestamp.toISOString(),
    cameraId: String(input.cameraId || "unknown-camera"),
    ingest_to_detect_ms: asNumberOrNull(input.ingest_to_detect_ms),
    detect_to_match_ms: asNumberOrNull(input.detect_to_match_ms),
    total_latency_ms: asNumberOrNull(input.total_latency_ms),
    match_confidence: asNumberOrNull(input.match_confidence),
    matched: Boolean(input.matched),
    source: String(input.source || "recognition"),
  };
}

function recordMetricEvent(input = {}) {
  const entry = normalizeEntry(input);
  push(entry);
  lastDetectionTime = entry.timestamp;
  return entry;
}

function getRecentMetrics(limit = MAX_RECENT_METRICS) {
  const normalizedLimit = Math.max(1, Math.min(bufferCount, Number(limit) || MAX_RECENT_METRICS));
  const output = [];

  for (let offset = 0; offset < normalizedLimit; offset += 1) {
    const index = (bufferWriteIndex - 1 - offset + MAX_RECENT_METRICS) % MAX_RECENT_METRICS;
    const item = buffer[index];
    if (!item) {
      continue;
    }

    output.push(item);
  }

  return output;
}

function getAverageLatency() {
  const values = getRecentMetrics(MAX_RECENT_METRICS)
    .map((item) => asNumberOrNull(item.total_latency_ms))
    .filter((item) => item !== null);

  if (values.length === 0) {
    return 0;
  }

  const total = values.reduce((sum, value) => sum + value, 0);
  return Number((total / values.length).toFixed(2));
}

function getLastDetectionTime() {
  return lastDetectionTime;
}

module.exports = {
  recordMetricEvent,
  getRecentMetrics,
  getAverageLatency,
  getLastDetectionTime,
};
