const LATENCY_BUFFER_SIZE = Number(process.env.RECOGNITION_LATENCY_BUFFER || 500);
const LIVENESS_REQUIRED_SAMPLES = Number(process.env.RECOGNITION_LIVENESS_REQUIRED_SAMPLES || 3);
const LIVENESS_MIN_SCORE = Number(process.env.RECOGNITION_LIVENESS_MIN_SCORE || 0.45);
const LIVENESS_MOTION_REFERENCE_PX = Number(process.env.RECOGNITION_LIVENESS_MOTION_REF_PX || 3.5);
const LIVENESS_DRIFT_REFERENCE = Number(process.env.RECOGNITION_LIVENESS_DRIFT_REF || 0.02);
const MAX_TRACK_SAMPLES = Number(process.env.RECOGNITION_LIVENESS_MAX_TRACK_SAMPLES || 8);

const metrics = {
  liveness_score: [],
  liveness_accepted: [],
  liveness_rejected: [],
  liveness_pending: [],
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function asNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeBox(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const x = Number(value.x);
  const y = Number(value.y);
  const width = Number(value.width);
  const height = Number(value.height);

  if (![x, y, width, height].every((item) => Number.isFinite(item))) {
    return null;
  }

  return { x, y, width, height };
}

function centerFromBox(box) {
  if (!box) {
    return null;
  }

  return {
    x: Number(box.x) + Number(box.width) / 2,
    y: Number(box.y) + Number(box.height) / 2,
  };
}

function distanceBetweenPoints(left, right) {
  if (!left || !right) {
    return 0;
  }

  const dx = Number(left.x || 0) - Number(right.x || 0);
  const dy = Number(left.y || 0) - Number(right.y || 0);
  return Math.sqrt(dx * dx + dy * dy);
}

function pushMetric(bucket, value) {
  if (!metrics[bucket] || !Number.isFinite(Number(value))) {
    return;
  }

  metrics[bucket].push(Number(value));
  if (metrics[bucket].length > LATENCY_BUFFER_SIZE) {
    metrics[bucket].shift();
  }
}

function percentile(values, ratio) {
  if (!values.length) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function summarize(values) {
  if (!values.length) {
    return {
      count: 0,
      avg: 0,
      min: 0,
      max: 0,
      p50: 0,
      p95: 0,
      p99: 0,
    };
  }

  const total = values.reduce((sum, value) => sum + value, 0);
  const min = Math.min(...values);
  const max = Math.max(...values);

  return {
    count: values.length,
    avg: Number((total / values.length).toFixed(3)),
    min: Number(min.toFixed(3)),
    max: Number(max.toFixed(3)),
    p50: Number(percentile(values, 0.5).toFixed(3)),
    p95: Number(percentile(values, 0.95).toFixed(3)),
    p99: Number(percentile(values, 0.99).toFixed(3)),
  };
}

function normalizeClientSignal(input) {
  if (!input || typeof input !== "object") {
    return null;
  }

  return {
    motionPx: asNumber(input.motionPx, 0),
    areaRatio: clamp(asNumber(input.areaRatio, 0), 0, 1),
    localConfidence: clamp(asNumber(input.localConfidence, 0), 0, 1),
    sampleAgeMs: Math.max(0, asNumber(input.sampleAgeMs, 0)),
  };
}

function recordTrackSignal(trackState, { box, descriptorDrift, timestamp, clientSignal } = {}) {
  if (!trackState) {
    return;
  }

  if (!Array.isArray(trackState.livenessSamples)) {
    trackState.livenessSamples = [];
  }

  const normalizedBox = normalizeBox(box);
  const currentCenter = centerFromBox(normalizedBox);
  const previous = trackState.livenessSamples[trackState.livenessSamples.length - 1] || null;
  const previousCenter = previous?.center || null;

  const motionPx = distanceBetweenPoints(previousCenter, currentCenter);

  trackState.livenessSamples.push({
    timestamp: Number(timestamp) || Date.now(),
    center: currentCenter,
    motionPx: Number(motionPx.toFixed(3)),
    descriptorDrift: Number(asNumber(descriptorDrift, 0).toFixed(5)),
    clientSignal: normalizeClientSignal(clientSignal),
  });

  if (trackState.livenessSamples.length > MAX_TRACK_SAMPLES) {
    trackState.livenessSamples.shift();
  }
}

function average(values = []) {
  if (!values.length) {
    return 0;
  }

  const total = values.reduce((sum, item) => sum + item, 0);
  return total / values.length;
}

function resolveMinimumScore(thresholdProfile = {}) {
  const profileMin = Number(thresholdProfile?.livenessMinScore);
  if (Number.isFinite(profileMin)) {
    return clamp(profileMin, 0.05, 0.95);
  }

  return clamp(LIVENESS_MIN_SCORE, 0.05, 0.95);
}

function evaluatePassiveLiveness({ trackState, thresholdProfile, clientSignal } = {}) {
  const required = Boolean(thresholdProfile?.highRisk);

  if (!required) {
    return {
      required: false,
      accepted: true,
      pending: false,
      score: 1,
      minimumScore: resolveMinimumScore(thresholdProfile),
      reason: "not_required",
      sampleCount: Array.isArray(trackState?.livenessSamples)
        ? trackState.livenessSamples.length
        : 0,
      signals: {
        motionScore: 1,
        descriptorScore: 1,
        clientScore: 1,
        sampleScore: 1,
      },
    };
  }

  const samples = Array.isArray(trackState?.livenessSamples) ? trackState.livenessSamples : [];
  const sampleCount = samples.length;

  const motionAvgPx = average(samples.map((sample) => asNumber(sample.motionPx, 0)));
  const descriptorDriftAvg = average(
    samples.map((sample) => asNumber(sample.descriptorDrift, 0))
  );

  const latestClientSignal = normalizeClientSignal(clientSignal)
    || normalizeClientSignal(samples[samples.length - 1]?.clientSignal)
    || null;

  const motionScore = clamp(motionAvgPx / Math.max(0.1, LIVENESS_MOTION_REFERENCE_PX), 0, 1);
  const descriptorScore = clamp(
    descriptorDriftAvg / Math.max(0.001, LIVENESS_DRIFT_REFERENCE),
    0,
    1
  );

  const clientMotionScore = latestClientSignal
    ? clamp(latestClientSignal.motionPx / Math.max(0.1, LIVENESS_MOTION_REFERENCE_PX), 0, 1)
    : 0;
  const clientAreaScore = latestClientSignal
    ? clamp(latestClientSignal.areaRatio / 0.06, 0, 1)
    : 0;
  const clientConfidenceScore = latestClientSignal
    ? clamp(latestClientSignal.localConfidence, 0, 1)
    : 0;
  const clientScore = clamp(
    clientMotionScore * 0.45 + clientAreaScore * 0.2 + clientConfidenceScore * 0.35,
    0,
    1
  );

  const sampleScore = clamp(sampleCount / Math.max(1, LIVENESS_REQUIRED_SAMPLES), 0, 1);

  const totalScore = clamp(
    motionScore * 0.3 + descriptorScore * 0.3 + clientScore * 0.25 + sampleScore * 0.15,
    0,
    1
  );

  const minimumScore = resolveMinimumScore(thresholdProfile);
  const pending = sampleCount < Math.max(1, LIVENESS_REQUIRED_SAMPLES);
  const accepted = !pending && totalScore >= minimumScore;

  pushMetric("liveness_score", totalScore);
  pushMetric("liveness_accepted", accepted ? 1 : 0);
  pushMetric("liveness_rejected", !accepted && !pending ? 1 : 0);
  pushMetric("liveness_pending", pending ? 1 : 0);

  return {
    required: true,
    accepted,
    pending,
    score: Number(totalScore.toFixed(3)),
    minimumScore: Number(minimumScore.toFixed(3)),
    reason: pending ? "insufficient_samples" : accepted ? "ok" : "score_below_threshold",
    sampleCount,
    signals: {
      motionScore: Number(motionScore.toFixed(3)),
      descriptorScore: Number(descriptorScore.toFixed(3)),
      clientScore: Number(clientScore.toFixed(3)),
      sampleScore: Number(sampleScore.toFixed(3)),
      motionAvgPx: Number(motionAvgPx.toFixed(3)),
      descriptorDriftAvg: Number(descriptorDriftAvg.toFixed(5)),
    },
  };
}

function getMetricsSnapshot() {
  return {
    liveness_score: summarize(metrics.liveness_score),
    liveness_accepted: summarize(metrics.liveness_accepted),
    liveness_rejected: summarize(metrics.liveness_rejected),
    liveness_pending: summarize(metrics.liveness_pending),
    config: {
      requiredSamples: LIVENESS_REQUIRED_SAMPLES,
      minScore: LIVENESS_MIN_SCORE,
      motionReferencePx: LIVENESS_MOTION_REFERENCE_PX,
      descriptorDriftReference: LIVENESS_DRIFT_REFERENCE,
    },
  };
}

module.exports = {
  recordTrackSignal,
  evaluatePassiveLiveness,
  getMetricsSnapshot,
};
