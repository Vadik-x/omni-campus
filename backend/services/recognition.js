const studentStore = require("./studentStore");
const annIndex = require("./annIndex");

const DEFAULT_DISTANCE_THRESHOLD = Number(process.env.RECOGNITION_DISTANCE_THRESHOLD || 0.45);
const MIN_MATCH_CONFIDENCE = Math.max(
  0,
  Math.min(1, Number(process.env.RECOGNITION_MIN_MATCH_CONFIDENCE || 0.7))
);
const CONFIDENCE_GATE_FLOOR = Math.max(
  0,
  Math.min(1, Number(process.env.RECOGNITION_CONFIDENCE_GATE_FLOOR || 0.45))
);
const CONFIDENCE_GATE_MARGIN = Math.max(
  0,
  Math.min(0.25, Number(process.env.RECOGNITION_CONFIDENCE_GATE_MARGIN || 0.05))
);
const DEFAULT_TOP_K = Number(process.env.RECOGNITION_TOP_K || 3);
const LATENCY_BUFFER_SIZE = Number(process.env.RECOGNITION_LATENCY_BUFFER || 500);
const MIN_DESCRIPTOR_LENGTH = Number(process.env.RECOGNITION_MIN_DESCRIPTOR_LENGTH || 64);
const MIN_DESCRIPTOR_NORM = Number(process.env.RECOGNITION_MIN_DESCRIPTOR_NORM || 0.01);
const MAX_DESCRIPTOR_NORM = Number(process.env.RECOGNITION_MAX_DESCRIPTOR_NORM || 20);
const QUALITY_MIN_BRIGHTNESS = Number(process.env.RECOGNITION_QUALITY_MIN_BRIGHTNESS || 40);
const QUALITY_MAX_BRIGHTNESS = Number(process.env.RECOGNITION_QUALITY_MAX_BRIGHTNESS || 220);
const QUALITY_MIN_CONTRAST = Number(process.env.RECOGNITION_QUALITY_MIN_CONTRAST || 18);
const QUALITY_MIN_SHARPNESS = Number(process.env.RECOGNITION_QUALITY_MIN_SHARPNESS || 12);
const QUALITY_MIN_DETECTION_SCORE = Number(process.env.RECOGNITION_QUALITY_MIN_DETECTION_SCORE || 0.22);
const QUALITY_MAX_ABS_YAW = Number(process.env.RECOGNITION_QUALITY_MAX_ABS_YAW || 35);
const QUALITY_MAX_ABS_PITCH = Number(process.env.RECOGNITION_QUALITY_MAX_ABS_PITCH || 35);

const metrics = {
  match_total_ms: [],
  match_search_ms: [],
  match_confidence_pct: [],
  match_search_space_templates: [],
  match_search_space_students: [],
  enroll_total_ms: [],
  enroll_quality_accepted: [],
  enroll_quality_rejected: [],
  reindex_total_ms: [],
};

let indexCache = {
  templates: [],
  builtAt: null,
  version: "",
};

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeDescriptor(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
}

function descriptorNorm(descriptor = []) {
  if (!Array.isArray(descriptor) || descriptor.length === 0) {
    return 0;
  }

  let sum = 0;
  descriptor.forEach((value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return;
    }

    sum += numeric * numeric;
  });

  return Math.sqrt(sum);
}

function descriptorDistance(a, b) {
  const left = normalizeDescriptor(a);
  const right = normalizeDescriptor(b);
  if (!left.length || !right.length) {
    return Number.POSITIVE_INFINITY;
  }

  const len = Math.min(left.length, right.length);
  let sum = 0;
  for (let index = 0; index < len; index += 1) {
    const diff = left[index] - right[index];
    sum += diff * diff;
  }

  return Math.sqrt(sum);
}

function confidenceFromDistance(distance) {
  if (!Number.isFinite(distance)) {
    return 0;
  }

  return clamp(1 - distance / 1.2, 0, 1);
}

function resolveEffectiveMinMatchConfidence(thresholdDistance) {
  const thresholdConfidence = confidenceFromDistance(thresholdDistance);
  const thresholdAlignedGate = clamp(
    thresholdConfidence - CONFIDENCE_GATE_MARGIN,
    CONFIDENCE_GATE_FLOOR,
    1
  );

  return Number(Math.min(MIN_MATCH_CONFIDENCE, thresholdAlignedGate).toFixed(3));
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

  const total = values.reduce((acc, current) => acc + current, 0);
  const min = Math.min(...values);
  const max = Math.max(...values);

  return {
    count: values.length,
    avg: Number((total / values.length).toFixed(2)),
    min: Number(min.toFixed(2)),
    max: Number(max.toFixed(2)),
    p50: Number(percentile(values, 0.5).toFixed(2)),
    p95: Number(percentile(values, 0.95).toFixed(2)),
    p99: Number(percentile(values, 0.99).toFixed(2)),
  };
}

function buildIndexVersion(students = []) {
  return students
    .map((student) => `${student.studentId}:${student.updatedAt || ""}`)
    .sort()
    .join("|");
}

function buildTemplates(students = studentStore.exportStudents()) {
  const templates = [];

  students.forEach((student) => {
    const descriptors = Array.isArray(student.faceDescriptors) && student.faceDescriptors.length > 0
      ? student.faceDescriptors
      : [student.faceDescriptor];

    descriptors.forEach((descriptor, templateIndex) => {
      const normalized = normalizeDescriptor(descriptor);
      if (!normalized.length) {
        return;
      }

      templates.push({
        studentId: student.studentId,
        studentName: student.name,
        descriptor: normalized,
        templateIndex,
      });
    });
  });

  const indexSummary = annIndex.buildIndex({
    templates,
    version: buildIndexVersion(students),
  });

  indexCache = {
    templates,
    builtAt: indexSummary.builtAt || new Date().toISOString(),
    version: indexSummary.version || buildIndexVersion(students),
    engine: indexSummary.engine,
  };

  return indexCache;
}

function ensureIndex() {
  const students = studentStore.exportStudents();
  const nextVersion = buildIndexVersion(students);
  if (!indexCache.builtAt || nextVersion !== indexCache.version) {
    return buildTemplates(students);
  }

  return indexCache;
}

function reindex() {
  const startedAt = nowMs();
  const snapshot = buildTemplates();
  const indexSummary = annIndex.getIndexSummary();
  const duration = nowMs() - startedAt;
  pushMetric("reindex_total_ms", duration);

  return {
    indexedTemplates: snapshot.templates.length,
    indexedStudents: new Set(snapshot.templates.map((item) => item.studentId)).size,
    builtAt: snapshot.builtAt,
    indexEngine: indexSummary.engine,
    durationMs: Number(duration.toFixed(2)),
  };
}

function validateDescriptorShape(descriptor = []) {
  if (!Array.isArray(descriptor) || descriptor.length < MIN_DESCRIPTOR_LENGTH) {
    throw new Error(
      `faceDescriptor must contain at least ${MIN_DESCRIPTOR_LENGTH} numeric values`
    );
  }

  const norm = descriptorNorm(descriptor);
  if (
    !Number.isFinite(norm)
    || norm < MIN_DESCRIPTOR_NORM
    || norm > MAX_DESCRIPTOR_NORM
  ) {
    throw new Error("faceDescriptor quality check failed (invalid vector norm)");
  }

  return {
    length: descriptor.length,
    norm: Number(norm.toFixed(4)),
  };
}

function validateEnrollmentQuality(inputQuality) {
  if (!inputQuality || typeof inputQuality !== "object") {
    return {
      applied: false,
      accepted: true,
      score: 0,
      checks: [],
    };
  }

  const quality = {
    brightness: Number(inputQuality.brightness),
    contrast: Number(inputQuality.contrast),
    sharpness: Number(inputQuality.sharpness),
    detectionScore: Number(inputQuality.detectionScore || inputQuality.score),
    poseYaw: Number(inputQuality.poseYaw),
    posePitch: Number(inputQuality.posePitch),
  };

  const checks = [];

  if (Number.isFinite(quality.brightness)) {
    checks.push({
      key: "brightness",
      ok:
        quality.brightness >= QUALITY_MIN_BRIGHTNESS
        && quality.brightness <= QUALITY_MAX_BRIGHTNESS,
      value: Number(quality.brightness.toFixed(2)),
      expected: `${QUALITY_MIN_BRIGHTNESS}-${QUALITY_MAX_BRIGHTNESS}`,
    });
  }

  if (Number.isFinite(quality.contrast)) {
    checks.push({
      key: "contrast",
      ok: quality.contrast >= QUALITY_MIN_CONTRAST,
      value: Number(quality.contrast.toFixed(2)),
      expected: `>=${QUALITY_MIN_CONTRAST}`,
    });
  }

  if (Number.isFinite(quality.sharpness)) {
    checks.push({
      key: "sharpness",
      ok: quality.sharpness >= QUALITY_MIN_SHARPNESS,
      value: Number(quality.sharpness.toFixed(2)),
      expected: `>=${QUALITY_MIN_SHARPNESS}`,
    });
  }

  if (Number.isFinite(quality.detectionScore)) {
    checks.push({
      key: "detectionScore",
      ok: quality.detectionScore >= QUALITY_MIN_DETECTION_SCORE,
      value: Number(quality.detectionScore.toFixed(4)),
      expected: `>=${QUALITY_MIN_DETECTION_SCORE}`,
    });
  }

  if (Number.isFinite(quality.poseYaw)) {
    checks.push({
      key: "poseYaw",
      ok: Math.abs(quality.poseYaw) <= QUALITY_MAX_ABS_YAW,
      value: Number(quality.poseYaw.toFixed(2)),
      expected: `<=|${QUALITY_MAX_ABS_YAW}|`,
    });
  }

  if (Number.isFinite(quality.posePitch)) {
    checks.push({
      key: "posePitch",
      ok: Math.abs(quality.posePitch) <= QUALITY_MAX_ABS_PITCH,
      value: Number(quality.posePitch.toFixed(2)),
      expected: `<=|${QUALITY_MAX_ABS_PITCH}|`,
    });
  }

  const appliedChecks = checks.length;
  const passedChecks = checks.filter((check) => check.ok).length;
  const accepted = appliedChecks === 0 || passedChecks === appliedChecks;
  const score = appliedChecks === 0 ? 0 : Number(((passedChecks / appliedChecks) * 100).toFixed(1));

  return {
    applied: appliedChecks > 0,
    accepted,
    score,
    checks,
  };
}

function enrollStudent(payload = {}) {
  const startedAt = nowMs();
  const descriptor = normalizeDescriptor(payload.faceDescriptor);
  if (!descriptor.length) {
    throw new Error("faceDescriptor is required for enrollment");
  }

  const descriptorShape = validateDescriptorShape(descriptor);
  const qualityReport = validateEnrollmentQuality(payload.quality || payload.captureQuality);

  if (qualityReport.applied && !qualityReport.accepted) {
    pushMetric("enroll_quality_rejected", 1);
    throw new Error("Enrollment quality checks failed. Capture a clearer face sample.");
  }

  const student = studentStore.registerStudent({
    ...payload,
    faceDescriptor: descriptor,
  });

  buildTemplates();
  const duration = nowMs() - startedAt;
  pushMetric("enroll_total_ms", duration);
  pushMetric("enroll_quality_accepted", qualityReport.accepted ? 1 : 0);

  return {
    student,
    descriptorCount: Array.isArray(student.faceDescriptors) ? student.faceDescriptors.length : 0,
    descriptorShape,
    quality: qualityReport,
    durationMs: Number(duration.toFixed(2)),
  };
}

function matchDescriptor({ descriptor, thresholdDistance, topK } = {}) {
  const startedAt = nowMs();
  const input = normalizeDescriptor(descriptor);
  if (!input.length) {
    throw new Error("descriptor must be a non-empty numeric array");
  }

  const { templates } = ensureIndex();
  const searchStartedAt = nowMs();

  const threshold = Number.isFinite(Number(thresholdDistance))
    ? Number(thresholdDistance)
    : DEFAULT_DISTANCE_THRESHOLD;
  const effectiveMinMatchConfidence = resolveEffectiveMinMatchConfidence(threshold);
  const limit = Number.isFinite(Number(topK)) ? Number(topK) : DEFAULT_TOP_K;
  const searchResult = annIndex.search({
    queryDescriptor: input,
    topK: Math.max(1, Math.min(20, limit)),
    confidenceFromDistance,
  });
  const searchDuration = nowMs() - searchStartedAt;
  pushMetric("match_search_ms", searchDuration);
  pushMetric("match_search_space_templates", Number(searchResult.searchSpace?.templatesScored || 0));
  pushMetric("match_search_space_students", Number(searchResult.searchSpace?.studentsConsidered || 0));

  const candidates = Array.isArray(searchResult.candidates)
    ? searchResult.candidates
    : [];
  const best = candidates[0] || null;
  const bestDistance = Number(best?.distance);
  const bestConfidence = Number(best?.confidence);
  const distancePass =
    Boolean(best)
    && Number.isFinite(bestDistance)
    && bestDistance <= threshold;
  const confidencePass =
    Boolean(best)
    && Number.isFinite(bestConfidence)
    && bestConfidence >= effectiveMinMatchConfidence;

  const totalDuration = nowMs() - startedAt;
  pushMetric("match_total_ms", totalDuration);
  if (best && Number.isFinite(Number(best.confidence))) {
    pushMetric("match_confidence_pct", Number(best.confidence) * 100);
  }

  return {
    matched: Boolean(distancePass && confidencePass),
    thresholdDistance: threshold,
    minMatchConfidence: MIN_MATCH_CONFIDENCE,
    effectiveMinMatchConfidence,
    best,
    candidates,
    durationMs: Number(totalDuration.toFixed(2)),
    searchDurationMs: Number(searchDuration.toFixed(2)),
    indexedTemplates: templates.length,
    indexEngine: searchResult.engine,
    searchSpace: searchResult.searchSpace,
  };
}

function getMetricsSnapshot() {
  return {
    windowSize: LATENCY_BUFFER_SIZE,
    match_total_ms: summarize(metrics.match_total_ms),
    match_search_ms: summarize(metrics.match_search_ms),
    match_confidence_pct: summarize(metrics.match_confidence_pct),
    match_search_space_templates: summarize(metrics.match_search_space_templates),
    match_search_space_students: summarize(metrics.match_search_space_students),
    enroll_total_ms: summarize(metrics.enroll_total_ms),
    enroll_quality_accepted: summarize(metrics.enroll_quality_accepted),
    enroll_quality_rejected: summarize(metrics.enroll_quality_rejected),
    reindex_total_ms: summarize(metrics.reindex_total_ms),
  };
}

function getHealthSummary() {
  const snapshot = ensureIndex();
  const indexSummary = annIndex.getIndexSummary();
  return {
    status: "ok",
    engine: "descriptor-v1",
    indexEngine: indexSummary.engine,
    thresholdDistance: DEFAULT_DISTANCE_THRESHOLD,
    minMatchConfidence: MIN_MATCH_CONFIDENCE,
    effectiveMinMatchConfidence: resolveEffectiveMinMatchConfidence(DEFAULT_DISTANCE_THRESHOLD),
    confidenceGateFloor: CONFIDENCE_GATE_FLOOR,
    confidenceGateMargin: CONFIDENCE_GATE_MARGIN,
    indexedTemplates: snapshot.templates.length,
    indexedStudents: new Set(snapshot.templates.map((item) => item.studentId)).size,
    indexBuiltAt: snapshot.builtAt,
    indexVersion: snapshot.version,
  };
}

module.exports = {
  enrollStudent,
  matchDescriptor,
  reindex,
  getMetricsSnapshot,
  getHealthSummary,
};
