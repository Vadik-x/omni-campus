const inferenceWorker = require("./inferenceWorker");
const studentStore = require("./studentStore");
const cameraThresholds = require("./cameraThresholds");
const passiveLiveness = require("./passiveLiveness");
const stabilityEngine = require("./stabilityEngine");
const logger = require("./logger");
const runtimeMetrics = require("./runtimeMetrics");
const runtimeAlerts = require("./runtimeAlerts");
const runtimeStats = require("./runtimeStats");

const LATENCY_BUFFER_SIZE = Number(process.env.RECOGNITION_LATENCY_BUFFER || 500);
const MAX_QUEUE_SIZE = Number(process.env.RECOGNITION_MAX_QUEUE || 25);
const TRACK_TTL_MS = Number(process.env.RECOGNITION_TRACK_TTL_MS || 8000);
const TRACK_REUSE_DISTANCE = Number(process.env.RECOGNITION_TRACK_REUSE_DISTANCE || 0.24);
const DETECT_EVERY_N = Number(process.env.RECOGNITION_DETECT_EVERY_N || 1);
const EMIT_COOLDOWN_MS = Number(process.env.RECOGNITION_EMIT_COOLDOWN_MS || 1000);
const MATCH_TIMEOUT_MS = Math.max(
  200,
  Number(process.env.RECOGNITION_MATCH_TIMEOUT_MS || 1200)
);

const metrics = {
  ingest_to_detect_ms: [],
  detect_to_match_ms: [],
  stability_process_ms: [],
  match_to_emit_ms: [],
  end_to_end_ms: [],
  queue_wait_ms: [],
  queue_depth: [],
  dropped_frames: [],
};

const cameraStates = new Map();

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function withTimeout(promise, timeoutMs, timeoutMessage) {
  let timeoutId = null;

  const timeoutPromise = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(timeoutMessage || "operation_timeout"));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

function toIsoTime(value) {
  const parsed = value ? new Date(value) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function asNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeDescriptor(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
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

function descriptorDistance(left, right) {
  const a = normalizeDescriptor(left);
  const b = normalizeDescriptor(right);

  if (!a.length || !b.length) {
    return Number.POSITIVE_INFINITY;
  }

  const len = Math.min(a.length, b.length);
  let sum = 0;

  for (let index = 0; index < len; index += 1) {
    const diff = a[index] - b[index];
    sum += diff * diff;
  }

  return Math.sqrt(sum);
}

function boxCenterDistance(left, right) {
  if (!left || !right) {
    return Number.POSITIVE_INFINITY;
  }

  const ax = left.x + left.width / 2;
  const ay = left.y + left.height / 2;
  const bx = right.x + right.width / 2;
  const by = right.y + right.height / 2;

  const dx = ax - bx;
  const dy = ay - by;
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
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1)
  );

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
    avg: Number((total / values.length).toFixed(2)),
    min: Number(min.toFixed(2)),
    max: Number(max.toFixed(2)),
    p50: Number(percentile(values, 0.5).toFixed(2)),
    p95: Number(percentile(values, 0.95).toFixed(2)),
    p99: Number(percentile(values, 0.99).toFixed(2)),
  };
}

function getOrCreateCameraState(cameraId) {
  const key = String(cameraId || "unknown-camera");

  if (!cameraStates.has(key)) {
    cameraStates.set(key, {
      cameraId: key,
      queue: [],
      processing: false,
      droppedFrames: 0,
      processedFrames: 0,
      tracks: new Map(),
      sequence: 0,
      lastEmitAt: 0,
      lastEmittedStudentId: "",
    });
  }

  return cameraStates.get(key);
}

function makeTrackId(cameraState, trackHint) {
  const hint = String(trackHint || "").trim();
  if (hint) {
    return hint;
  }

  cameraState.sequence += 1;
  return `track-${cameraState.sequence}`;
}

function pruneTracks(cameraState, nowTs) {
  for (const [trackId, track] of cameraState.tracks.entries()) {
    if (nowTs - track.lastSeenAt > TRACK_TTL_MS) {
      cameraState.tracks.delete(trackId);
    }
  }
}

function findClosestActiveTrack(cameraState, box, nowTs) {
  if (!box) {
    return {
      trackId: null,
      distance: Number.POSITIVE_INFINITY,
    };
  }

  let bestTrackId = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const [trackId, track] of cameraState.tracks.entries()) {
    if (nowTs - track.lastSeenAt > TRACK_TTL_MS) {
      continue;
    }

    const distance = boxCenterDistance(box, track.lastBox);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestTrackId = trackId;
    }
  }

  return {
    trackId: bestTrackId,
    distance: bestDistance,
  };
}

function resolveTrack(cameraState, { trackHint, box, nowTs }) {
  const hintedTrackId = String(trackHint || "").trim();
  if (hintedTrackId) {
    const hintedTrack = cameraState.tracks.get(hintedTrackId);
    if (hintedTrack && nowTs - hintedTrack.lastSeenAt <= TRACK_TTL_MS) {
      return hintedTrackId;
    }

    // Some camera feeds produce unstable frontend track hints; remap to the
    // closest active backend track to preserve temporal lock continuity.
    const nearest = findClosestActiveTrack(cameraState, box, nowTs);
    if (nearest.trackId && nearest.distance <= Math.max(60, Number(box?.width || 0))) {
      return nearest.trackId;
    }

    if (!box) {
      return `${cameraState.cameraId}-primary`;
    }

    return hintedTrackId;
  }

  if (!box) {
    return `${cameraState.cameraId}-primary`;
  }

  const nearest = findClosestActiveTrack(cameraState, box, nowTs);
  if (nearest.trackId && nearest.distance <= Math.max(60, box.width)) {
    return nearest.trackId;
  }

  return makeTrackId(cameraState, "");
}

function getOrCreateTrackState(cameraState, trackId) {
  if (!cameraState.tracks.has(trackId)) {
    cameraState.tracks.set(trackId, {
      trackId,
      frameCounter: 0,
      lastSeenAt: Date.now(),
      lastBox: null,
      lastDescriptor: null,
      lastMatchResult: null,
      livenessSamples: [],
    });
  }

  return cameraState.tracks.get(trackId);
}

function queueSnapshot() {
  const cameras = Array.from(cameraStates.values());

  const queueDepths = cameras.map((state) => state.queue.length);
  const activeTracks = cameras.reduce((sum, state) => sum + state.tracks.size, 0);
  const droppedFrames = cameras.reduce((sum, state) => sum + state.droppedFrames, 0);
  const processedFrames = cameras.reduce((sum, state) => sum + state.processedFrames, 0);

  return {
    active_cameras: cameras.length,
    active_tracks: activeTracks,
    queued_frames: queueDepths.reduce((sum, value) => sum + value, 0),
    max_queue_depth: queueDepths.length ? Math.max(...queueDepths) : 0,
    dropped_frames_total: droppedFrames,
    processed_frames_total: processedFrames,
    config: {
      maxQueueSize: MAX_QUEUE_SIZE,
      trackTtlMs: TRACK_TTL_MS,
      detectEveryN: DETECT_EVERY_N,
      emitCooldownMs: EMIT_COOLDOWN_MS,
    },
  };
}

function pushQueueDepthMetrics() {
  const snapshot = queueSnapshot();
  pushMetric("queue_depth", snapshot.max_queue_depth);
  pushMetric("dropped_frames", snapshot.dropped_frames_total);
}

function buildFallbackMatchResult({
  cameraId,
  cameraLabel,
  thresholdDistance,
  trackId,
  queueDepth,
  droppedFrames,
  reason,
  message,
} = {}) {
  const resolvedTrackId = String(trackId || "unknown-track");

  return {
    cameraId: String(cameraId || "unknown-camera"),
    trackId: resolvedTrackId,
    status: "lost",
    stableId: null,
    stableIdentities: [],
    uiState: {
      phase: "lost",
      phaseLegacy: "lost",
      label: "No stable identity",
      message: "No stable identity",
      confidenceLevel: "low",
      trackId: resolvedTrackId,
      cameraId: String(cameraId || "unknown-camera"),
      stableId: null,
      stableName: null,
      lockRemainingMs: 0,
      isLocked: false,
      isSwitching: false,
      switchingProgress: 0,
      transitions: {
        looking: false,
        recognizing: false,
        detecting: false,
        locked: false,
        switching: false,
        lost: true,
      },
      stableIdentities: [],
    },
    confidence: 0,
    latencyMs: 0,
    framesAnalyzed: 0,
    matched: false,
    rawMatched: false,
    thresholdDistance: asNumber(thresholdDistance, 0),
    best: null,
    candidates: [],
    durationMs: 0,
    searchDurationMs: 0,
    indexedTemplates: 0,
    eventEmitted: false,
    student: null,
    fallback: true,
    fallbackReason: String(reason || "pipeline_error"),
    pipeline: {
      cameraId: String(cameraId || "unknown-camera"),
      cameraLabel: String(cameraLabel || "Unknown Camera"),
      trackId: resolvedTrackId,
      decision: "fallback_error",
      queueDepth: Number(queueDepth || 0),
      droppedFrames: Number(droppedFrames || 0),
      reusedByTracker: false,
      liveness: {
        required: false,
        accepted: false,
        pending: false,
        reason: String(reason || "pipeline_error"),
      },
      worker: inferenceWorker.getWorkerInfo(),
      message: String(message || "Recognition fallback response generated"),
    },
  };
}

async function processMatchItem(cameraState, item, io) {
  const nowTs = Date.now();
  const payload = item?.payload || {};
  const cameraId = String(payload.cameraId || cameraState.cameraId || "unknown-camera");
  const cameraLabel = String(payload.cameraLabel || "Unknown Camera");
  const timestampIso = toIsoTime(payload.timestamp);

  try {
    const descriptor = normalizeDescriptor(payload.descriptor);
    if (!descriptor.length) {
      throw new Error("descriptor must be a non-empty numeric array");
    }

    const enqueueWaitMs = Math.max(0, nowTs - item.enqueuedAt);
    pushMetric("queue_wait_ms", enqueueWaitMs);
    pushQueueDepthMetrics();

    const ingestToDetectMs = asNumber(
      payload.ingestToDetectMs,
      asNumber(payload.detectDurationMs, 0)
    );
    pushMetric("ingest_to_detect_ms", ingestToDetectMs);

    const parsedBox = normalizeBox(payload.box);
    pruneTracks(cameraState, nowTs);
    const trackId = resolveTrack(cameraState, {
      trackHint: payload.trackHint,
      box: parsedBox,
      nowTs,
    });
    const trackState = getOrCreateTrackState(cameraState, trackId);

    trackState.frameCounter += 1;
    trackState.lastSeenAt = nowTs;
    if (parsedBox) {
      trackState.lastBox = parsedBox;
    }

    let matchResult = null;
    let reusedByTracker = false;
    let detectToMatchMsValue = 0;

    const thresholdProfile = cameraThresholds.resolveThreshold({
      cameraId,
      cameraLabel,
      requestedThreshold: payload.thresholdDistance,
    });

    const descriptorDrift = descriptorDistance(trackState.lastDescriptor, descriptor);
    passiveLiveness.recordTrackSignal(trackState, {
      box: parsedBox,
      descriptorDrift,
      timestamp: nowTs,
      clientSignal: payload.liveness,
    });

    const canReuseByTracker =
      Boolean(trackState.lastMatchResult)
      && Number.isFinite(descriptorDrift)
      && descriptorDrift <= TRACK_REUSE_DISTANCE
      && trackState.frameCounter % Math.max(1, DETECT_EVERY_N) !== 0;

    if (canReuseByTracker) {
      reusedByTracker = true;
      matchResult = {
        ...trackState.lastMatchResult,
        durationMs: asNumber(trackState.lastMatchResult.durationMs, 0),
        searchDurationMs: asNumber(trackState.lastMatchResult.searchDurationMs, 0),
      };
      pushMetric("detect_to_match_ms", 0);
    } else {
      const matchStartedAt = nowMs();
      try {
        matchResult = await withTimeout(
          inferenceWorker.executeMatch({
            descriptor,
            thresholdDistance: thresholdProfile.thresholdDistance,
            topK: payload.topK,
          }),
          MATCH_TIMEOUT_MS,
          "recognition_match_timeout"
        );
      } catch (error) {
        runtimeAlerts.createAlert({
          type: "recognition_fallback",
          cameraId,
          message: `Recognition fallback used: ${error.message}`,
          details: {
            reason: error.message,
            timeoutMs: MATCH_TIMEOUT_MS,
          },
          dedupeKey: `recognition_fallback:${cameraId}`,
        });

        logger.error({
          service: "recognition",
          event: "recognition.match_failed",
          cameraId,
          message: "Recognition worker failed; fallback result emitted",
          error,
          details: {
            timeoutMs: MATCH_TIMEOUT_MS,
          },
        });

        matchResult = {
          matched: false,
          thresholdDistance: thresholdProfile.thresholdDistance,
          best: null,
          candidates: [],
          durationMs: 0,
          searchDurationMs: 0,
          indexedTemplates: 0,
        };
      }

      detectToMatchMsValue = nowMs() - matchStartedAt;
      pushMetric("detect_to_match_ms", detectToMatchMsValue);
      trackState.lastMatchResult = matchResult;
    }

    trackState.lastDescriptor = descriptor;

    const rawMatched = Boolean(matchResult?.matched && matchResult?.best?.studentId);
    const rawCandidate = rawMatched ? matchResult.best : null;
    const liveness = passiveLiveness.evaluatePassiveLiveness({
      trackState,
      thresholdProfile,
      clientSignal: payload.liveness,
    });
    const livenessBlocked = rawMatched && liveness.required && !liveness.accepted;
    const stabilityInputLatencyMs = Math.max(
      0,
      nowTs - new Date(timestampIso).getTime()
    );

    const stabilityStartedAt = nowMs();
    const stability = stabilityEngine.processFrame({
      cameraId,
      trackId,
      timestamp: nowTs,
      detectedId: livenessBlocked ? "" : String(rawCandidate?.studentId || ""),
      detectedName: livenessBlocked ? "" : String(rawCandidate?.studentName || ""),
      confidence: livenessBlocked ? 0 : asNumber(rawCandidate?.confidence, 0),
      pipelineLatencyMs: stabilityInputLatencyMs,
      descriptorDrift,
      box: parsedBox,
    });
    const stabilityLatencyMs = nowMs() - stabilityStartedAt;
    pushMetric("stability_process_ms", stabilityLatencyMs);

    const stableMatched = stability.status === "confirmed" && Boolean(stability.stableId);

    (Array.isArray(stability.events) ? stability.events : []).forEach((entry) => {
      logger.info({
        service: "recognition",
        event: String(entry?.type || "stability_event"),
        cameraId,
        confidence: asNumber(stability.confidence, 0),
        message: String(entry?.message || "Stability event"),
        details: entry?.details || {},
      });
    });

    let eventEmitted = false;
    let student = null;
    let matchToEmitMs = 0;

    if (stableMatched && stability.shouldEmit) {
      const stableStudentId = String(stability.stableId || "");
      const withinCooldown =
        cameraState.lastEmittedStudentId === stableStudentId
        && nowTs - cameraState.lastEmitAt < EMIT_COOLDOWN_MS;

      if (!withinCooldown) {
        const emitStartedAt = nowMs();
        student = studentStore.applyFaceDetection({
          studentId: stableStudentId,
          studentName:
            String(stability.stableName || "")
            || String(rawCandidate?.studentName || "")
            || "Unknown",
          cameraId,
          cameraLabel,
          confidence: asNumber(stability.confidence, 0),
          timestamp: timestampIso,
          latencyMs: asNumber(matchResult.durationMs, 0),
        });

        if (student) {
          io.emit("student:update", student);
          io.emit("detection:event", {
            studentId: student.studentId,
            studentName: student.name,
            cameraId,
            cameraLabel,
            location: student.currentLocation?.buildingName || "Unknown Camera",
            method: "FACE-API",
            confidence: asNumber(stability.confidence, 0),
            timestamp: timestampIso,
          });

          eventEmitted = true;
          cameraState.lastEmitAt = nowTs;
          cameraState.lastEmittedStudentId = stableStudentId;
        }

        matchToEmitMs = nowMs() - emitStartedAt;
        pushMetric("match_to_emit_ms", matchToEmitMs);
      }
    }

    if (!eventEmitted) {
      pushMetric("match_to_emit_ms", 0);
    }

    const endToEndMs = Math.max(0, Date.now() - new Date(timestampIso).getTime());
    pushMetric("end_to_end_ms", endToEndMs);
    cameraState.processedFrames += 1;

    let best = matchResult.best;
    if (stableMatched) {
      best = {
        ...(matchResult.best || {}),
        studentId: String(stability.stableId || ""),
        studentName:
          String(stability.stableName || "")
          || String(matchResult?.best?.studentName || "")
          || "Unknown",
        confidence: asNumber(stability.confidence, 0),
      };
    }

    const finalDecision =
      stability.status === "switching" || stability?.uiState?.phase === "switching"
        ? "switching"
        : stability.status === "confirmed"
          ? "confirmed"
          : livenessBlocked
            ? liveness.pending
              ? "liveness_pending"
              : "liveness_rejected"
            : stability.status;

    const confidence = asNumber(
      stability.confidence,
      asNumber(best?.confidence, 0)
    );

    runtimeMetrics.recordMetricEvent({
      timestamp: timestampIso,
      cameraId,
      ingest_to_detect_ms: ingestToDetectMs,
      detect_to_match_ms: detectToMatchMsValue,
      total_latency_ms: endToEndMs,
      match_confidence: confidence,
      matched: stableMatched,
      source: "recognition_pipeline",
    });

    runtimeStats.recordDetection({
      cameraId,
      matched: stableMatched,
      totalLatencyMs: endToEndMs,
    });

    runtimeAlerts.evaluateDetectionWarnings({
      cameraId,
      totalLatencyMs: endToEndMs,
      confidence,
      confidenceThreshold: asNumber(1 - thresholdProfile.thresholdDistance, 0.5),
    });

    logger.info({
      service: "recognition",
      event: stableMatched ? "recognition.match_success" : "recognition.match_failure",
      cameraId,
      latencyMs: endToEndMs,
      confidence,
      message: stableMatched ? "Face detected and matched" : "Face detected but not matched",
      details: {
        decision: finalDecision,
        eventEmitted,
        reusedByTracker,
      },
    });

    return {
      cameraId,
      trackId,
      status: stability.status,
      stableId: stability.stableId,
      stableIdentities: Array.isArray(stability.stableIdentities) ? stability.stableIdentities : [],
      uiState: stability.uiState || null,
      confidence,
      latencyMs: Number(endToEndMs.toFixed(2)),
      framesAnalyzed: asNumber(stability.framesAnalyzed, 0),
      ...(stability.predictionUsed !== undefined ? { predictionUsed: stability.predictionUsed } : {}),
      ...(stability.motionDelta !== undefined ? { motionDelta: stability.motionDelta } : {}),
      ...(stability.smoothedConfidence !== undefined ? { smoothedConfidence: stability.smoothedConfidence } : {}),
      ...(stability.switchingProgress !== undefined ? { switchingProgress: stability.switchingProgress } : {}),
      ...(stability.activeTracks !== undefined ? { activeTracks: stability.activeTracks } : {}),
      ...(stability.debug ? { debug: stability.debug } : {}),
      matched: stableMatched,
      rawMatched,
      thresholdDistance: matchResult.thresholdDistance,
      best,
      candidates: Array.isArray(matchResult?.candidates) ? matchResult.candidates : [],
      durationMs: asNumber(matchResult?.durationMs, 0),
      searchDurationMs: asNumber(matchResult?.searchDurationMs, 0),
      indexedTemplates: asNumber(matchResult?.indexedTemplates, 0),
      eventEmitted,
      student,
      pipeline: {
        cameraId,
        cameraLabel,
        cameraThreshold: thresholdProfile,
        trackId,
        decision: finalDecision,
        detectEveryN: DETECT_EVERY_N,
        liveness,
        stability: {
          trackId: String(stability.trackId || trackId),
          status: stability.status,
          stableId: stability.stableId,
          stableIdentities: Array.isArray(stability.stableIdentities)
            ? stability.stableIdentities
            : [],
          activeTrackCount: asNumber(stability.activeTrackCount, 0),
          uiState: stability.uiState || null,
          phase: String(stability?.uiState?.phase || ""),
          phaseLegacy: String(stability?.uiState?.phaseLegacy || ""),
          message: String(stability?.uiState?.message || stability?.uiState?.label || ""),
          confidenceLevel: String(stability?.uiState?.confidenceLevel || ""),
          confidence: asNumber(stability.confidence, 0),
          framesAnalyzed: asNumber(stability.framesAnalyzed, 0),
          lockRemainingMs: asNumber(stability.lockRemainingMs, 0),
          consecutiveFrames: asNumber(stability.consecutiveFrames, 0),
          averageConfidence: asNumber(stability.averageConfidence, 0),
          confirmThreshold: asNumber(stability.confirmThreshold, 0),
          predictionUsed: Boolean(stability.predictionUsed),
          motionDelta: asNumber(stability.motionDelta, 0),
          smoothedConfidence: asNumber(stability.smoothedConfidence, 0),
          switchingProgress: asNumber(stability.switchingProgress, 0),
          activeTracks: asNumber(stability.activeTracks, asNumber(stability.activeTrackCount, 0)),
          latencyMs: Number(stabilityLatencyMs.toFixed(3)),
          ...(stability.debug ? { debug: stability.debug } : {}),
        },
        reusedByTracker,
        descriptorDrift: Number.isFinite(descriptorDrift)
          ? Number(descriptorDrift.toFixed(4))
          : null,
        queueWaitMs: Number(enqueueWaitMs.toFixed(2)),
        queueDepth: cameraState.queue.length,
        droppedFrames: cameraState.droppedFrames,
        worker: inferenceWorker.getWorkerInfo(),
      },
    };
  } catch (error) {
    logger.error({
      service: "recognition",
      event: "recognition.pipeline_error",
      cameraId,
      message: "Recognition pipeline processing failed",
      error,
    });

    runtimeAlerts.createAlert({
      type: "pipeline_error",
      cameraId,
      message: `Recognition pipeline error: ${error.message}`,
      details: {
        error: error.message,
      },
      dedupeKey: `pipeline_error:${cameraId}`,
    });

    runtimeMetrics.recordMetricEvent({
      timestamp: timestampIso,
      cameraId,
      ingest_to_detect_ms: null,
      detect_to_match_ms: null,
      total_latency_ms: null,
      match_confidence: null,
      matched: false,
      source: "recognition_pipeline_fallback",
    });

    runtimeStats.recordDetection({
      cameraId,
      matched: false,
      totalLatencyMs: null,
    });

    return buildFallbackMatchResult({
      cameraId,
      cameraLabel,
      thresholdDistance: payload.thresholdDistance,
      trackId: payload.trackHint,
      queueDepth: cameraState.queue.length,
      droppedFrames: cameraState.droppedFrames,
      reason: "pipeline_error",
      message: error.message,
    });
  }
}

function consumeCameraQueue(cameraState, io) {
  if (cameraState.processing) {
    return;
  }

  if (cameraState.queue.length === 0) {
    return;
  }

  const item = cameraState.queue.shift();
  if (!item) {
    return;
  }

  cameraState.processing = true;

  processMatchItem(cameraState, item, io)
    .then((result) => {
      item.resolve(result);
    })
    .catch((error) => {
      logger.error({
        service: "recognition",
        event: "recognition.queue_consume_error",
        cameraId: item?.payload?.cameraId || cameraState.cameraId,
        message: "Queue consumer failed, returning fallback result",
        error,
      });

      item.resolve(
        buildFallbackMatchResult({
          cameraId: item?.payload?.cameraId || cameraState.cameraId,
          cameraLabel: item?.payload?.cameraLabel,
          thresholdDistance: item?.payload?.thresholdDistance,
          trackId: item?.payload?.trackHint,
          queueDepth: cameraState.queue.length,
          droppedFrames: cameraState.droppedFrames,
          reason: "queue_consume_error",
          message: error.message,
        })
      );
    })
    .finally(() => {
      cameraState.processing = false;
      setImmediate(() => consumeCameraQueue(cameraState, io));
    });
}

function enqueueMatch(payload, io) {
  const cameraId = String(payload?.cameraId || "unknown-camera");
  const cameraState = getOrCreateCameraState(cameraId);

  return new Promise((resolve, reject) => {
    const nextItem = {
      payload: payload || {},
      enqueuedAt: Date.now(),
      resolve,
      reject,
    };

    if (cameraState.queue.length >= MAX_QUEUE_SIZE) {
      const droppedItem = cameraState.queue.shift();
      cameraState.droppedFrames += 1;
      pushMetric("dropped_frames", cameraState.droppedFrames);
      if (droppedItem) {
        droppedItem.resolve({
          cameraId,
          trackId: "unknown-track",
          status: "lost",
          stableId: null,
          stableIdentities: [],
          uiState: {
            phase: "lost",
            phaseLegacy: "lost",
            label: "No stable identity",
            message: "No stable identity",
            confidenceLevel: "low",
            trackId: "unknown-track",
            cameraId,
            stableId: null,
            stableName: null,
            lockRemainingMs: 0,
            isLocked: false,
            isSwitching: false,
            switchingProgress: 0,
            transitions: {
              looking: false,
              recognizing: false,
              detecting: false,
              locked: false,
              switching: false,
              lost: true,
            },
            stableIdentities: [],
          },
          confidence: 0,
          latencyMs: 0,
          framesAnalyzed: 0,
          matched: false,
          eventEmitted: false,
          dropped: true,
          reason: "queue_overflow",
          pipeline: {
            cameraId,
            queueDepth: cameraState.queue.length,
            droppedFrames: cameraState.droppedFrames,
          },
        });
      }
    }

    cameraState.queue.push(nextItem);
    pushMetric("queue_depth", cameraState.queue.length);
    consumeCameraQueue(cameraState, io);
  });
}

function getPipelineMetricsSnapshot() {
  const queue = queueSnapshot();

  return {
    ingest_to_detect_ms: summarize(metrics.ingest_to_detect_ms),
    detect_to_match_ms: summarize(metrics.detect_to_match_ms),
    stability_process_ms: summarize(metrics.stability_process_ms),
    match_to_emit_ms: summarize(metrics.match_to_emit_ms),
    end_to_end_ms: summarize(metrics.end_to_end_ms),
    queue_wait_ms: summarize(metrics.queue_wait_ms),
    queue_depth: summarize(metrics.queue_depth),
    dropped_frames: summarize(metrics.dropped_frames),
    passive_liveness: passiveLiveness.getMetricsSnapshot(),
    queue,
  };
}

function getPipelineHealthSummary() {
  const queue = queueSnapshot();
  const stability = stabilityEngine.getStabilityHealthSummary();

  return {
    status: "ok",
    worker: inferenceWorker.getWorkerInfo(),
    matchTimeoutMs: MATCH_TIMEOUT_MS,
    stability,
    pipeline: queue,
  };
}

module.exports = {
  enqueueMatch,
  getPipelineMetricsSnapshot,
  getPipelineHealthSummary,
};
