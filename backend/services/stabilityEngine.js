const BUFFER_SIZE = Math.max(
  10,
  Math.min(15, Number(process.env.RECOGNITION_STABILITY_BUFFER_SIZE || 12))
);
const CONSECUTIVE_MIN_FRAMES = Math.max(
  2,
  Number(process.env.RECOGNITION_STABILITY_CONSECUTIVE_MIN || 3)
);
const CONFIRM_CONFIDENCE_THRESHOLD = Math.max(
  0.4,
  Math.min(0.99, Number(process.env.RECOGNITION_STABILITY_CONFIRM_THRESHOLD || 0.75))
);
const LOCK_MS = Math.max(
  1000,
  Math.min(2000, Number(process.env.RECOGNITION_STABILITY_LOCK_MS || 1500))
);
const SWITCH_CONFIDENCE_DELTA = Math.max(
  0,
  Math.min(0.5, Number(process.env.RECOGNITION_STABILITY_SWITCH_DELTA || 0.1))
);
const ADAPTIVE_LATENCY_THRESHOLD_MS = Math.max(
  150,
  Number(process.env.RECOGNITION_STABILITY_ADAPTIVE_LATENCY_MS || 650)
);
const ADAPTIVE_THRESHOLD_BOOST = Math.max(
  0,
  Math.min(0.2, Number(process.env.RECOGNITION_STABILITY_ADAPTIVE_THRESHOLD_BOOST || 0.04))
);
const STABLE_CONFIDENCE_DECAY = Math.max(
  0.8,
  Math.min(1, Number(process.env.RECOGNITION_STABILITY_CONFIDENCE_DECAY || 0.97))
);
const STABLE_CONFIDENCE_MIN = Math.max(
  0,
  Math.min(0.8, Number(process.env.RECOGNITION_STABILITY_CONFIDENCE_MIN || 0.25))
);
const NO_DETECTION_GRACE_MS = Math.max(
  1000,
  Math.min(2000, Number(process.env.RECOGNITION_STABILITY_NO_DETECTION_GRACE_MS || 1500))
);
const NO_DETECTION_MAX_DRIFT = Math.max(
  0.05,
  Math.min(0.8, Number(process.env.RECOGNITION_STABILITY_NO_DETECTION_MAX_DRIFT || 0.35))
);
const MAX_CAMERAS = Math.max(
  10,
  Math.min(500, Number(process.env.RECOGNITION_STABILITY_MAX_CAMERAS || 120))
);
const MAX_TRACKS_PER_CAMERA = Math.max(
  2,
  Math.min(4, Number(process.env.RECOGNITION_STABILITY_TRACK_SLOTS || 2))
);
const TRACK_TTL_MS = Math.max(
  3000,
  Number(process.env.RECOGNITION_STABILITY_TRACK_TTL_MS || 8000)
);

const PREDICTION_CONFIDENCE_BOOST = clampEnv(
  process.env.RECOGNITION_STABILITY_PREDICTION_BOOST,
  0.07,
  0,
  0.12
);
const PREDICTION_MISMATCH_PENALTY = clampEnv(
  process.env.RECOGNITION_STABILITY_PREDICTION_MISMATCH_PENALTY,
  0.06,
  0,
  0.18
);
const PREDICTION_SWITCH_PERSIST_FRAMES = Math.max(
  2,
  Number(process.env.RECOGNITION_STABILITY_SWITCH_PERSIST_FRAMES || 2)
);

const MOTION_SMALL_SHIFT_PX = Math.max(
  8,
  Number(process.env.RECOGNITION_STABILITY_MOTION_SMALL_SHIFT_PX || 36)
);
const MOTION_LARGE_SHIFT_PX = Math.max(
  MOTION_SMALL_SHIFT_PX + 10,
  Number(process.env.RECOGNITION_STABILITY_MOTION_LARGE_SHIFT_PX || 92)
);
const MOTION_CONFIDENCE_BOOST = clampEnv(
  process.env.RECOGNITION_STABILITY_MOTION_BOOST,
  0.04,
  0,
  0.1
);
const MOTION_JUMP_PENALTY = clampEnv(
  process.env.RECOGNITION_STABILITY_MOTION_JUMP_PENALTY,
  0.08,
  0,
  0.2
);

const CONFIDENCE_SMOOTHING_ALPHA = clampEnv(
  process.env.RECOGNITION_STABILITY_SMOOTHING_ALPHA,
  0.3,
  0.05,
  0.8
);
const PERFORMANCE_TARGET_MS = Math.max(
  1,
  Number(process.env.RECOGNITION_STABILITY_PERF_TARGET_MS || 5)
);

const DEFAULT_TRACK_ID = "default-track";
const DEBUG_ENABLED =
  String(process.env.RECOGNITION_STABILITY_DEBUG || "false").toLowerCase() === "true"
  || String(process.env.DEBUG || "false").toLowerCase() === "true";

const cameraBuffers = new Map();

function clampEnv(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return Math.max(min, Math.min(max, Number(fallback)));
  }

  return Math.max(min, Math.min(max, numeric));
}

function asNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hiResNowMs() {
  if (typeof process !== "undefined" && process.hrtime && typeof process.hrtime.bigint === "function") {
    return Number(process.hrtime.bigint()) / 1e6;
  }

  return Date.now();
}

function toCameraKey(cameraId) {
  return String(cameraId || "unknown-camera").trim() || "unknown-camera";
}

function toTrackKey(trackId) {
  return String(trackId || DEFAULT_TRACK_ID).trim() || DEFAULT_TRACK_ID;
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

  return {
    x,
    y,
    width,
    height,
  };
}

function centerFromBox(box) {
  if (!box) {
    return null;
  }

  return {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  };
}

function distanceBetweenPoints(left, right) {
  if (!left || !right) {
    return 0;
  }

  return Math.hypot(
    asNumber(left.x, 0) - asNumber(right.x, 0),
    asNumber(left.y, 0) - asNumber(right.y, 0)
  );
}

function confidenceLevel(value) {
  const confidence = clamp(asNumber(value, 0), 0, 1);

  if (confidence >= 0.8) {
    return "high";
  }

  if (confidence >= 0.55) {
    return "medium";
  }

  return "low";
}

function createTrackState(trackId, now) {
  return {
    trackId,
    frames: [],
    stableId: "",
    stableName: "",
    stableConfidence: 0,
    smoothedConfidence: 0,
    lockedId: "",
    lockUntil: 0,
    lastDetectionAt: 0,
    lastPipelineLatencyMs: 0,
    lastRawConfidence: 0,
    lastStatus: "detecting",
    lastSwitchingSignal: false,
    lastUpdatedAt: now,
    lastPosition: null,
    lastBox: null,
    movementDelta: 0,
    lastPredictionUsed: false,
    lastPredictionMatched: false,
    predictionMismatchFrames: 0,
    switchCandidateId: "",
    switchCandidateFrames: 0,
    switchingStartedAt: 0,
    switchingProgress: 0,
  };
}

function resetSwitchCandidate(trackState) {
  trackState.switchCandidateId = "";
  trackState.switchCandidateFrames = 0;
  trackState.switchingStartedAt = 0;
  trackState.switchingProgress = 0;
}

function pruneCameraIfNeeded() {
  if (cameraBuffers.size < MAX_CAMERAS) {
    return;
  }

  let oldestKey = "";
  let oldestTimestamp = Number.POSITIVE_INFINITY;

  for (const [key, state] of cameraBuffers.entries()) {
    const ts = Number(state?.lastUpdatedAt || 0);
    if (ts < oldestTimestamp) {
      oldestTimestamp = ts;
      oldestKey = key;
    }
  }

  if (oldestKey) {
    cameraBuffers.delete(oldestKey);
  }
}

function getOrCreateCameraState(cameraId) {
  const key = toCameraKey(cameraId);

  if (!cameraBuffers.has(key)) {
    pruneCameraIfNeeded();

    cameraBuffers.set(key, {
      cameraId: key,
      tracks: new Map(),
      lastUpdatedAt: Date.now(),
    });
  }

  return cameraBuffers.get(key);
}

function clearIdentity(trackState) {
  trackState.stableId = "";
  trackState.stableName = "";
  trackState.stableConfidence = 0;
  trackState.lockedId = "";
  trackState.lockUntil = 0;
  trackState.predictionMismatchFrames = 0;
  trackState.lastPredictionUsed = false;
  trackState.lastPredictionMatched = false;
  resetSwitchCandidate(trackState);
}

function pushFrame(trackState, frame) {
  trackState.frames.push(frame);
  if (trackState.frames.length > BUFFER_SIZE) {
    trackState.frames.shift();
  }
}

function trailingRunForId(frames, id) {
  const targetId = String(id || "");
  if (!targetId) {
    return {
      consecutiveFrames: 0,
      averageConfidence: 0,
    };
  }

  let count = 0;
  let sumConfidence = 0;

  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    if (String(frame?.detectedId || "") !== targetId) {
      break;
    }

    count += 1;
    sumConfidence += asNumber(frame?.confidence, 0);
  }

  if (count === 0) {
    return {
      consecutiveFrames: 0,
      averageConfidence: 0,
    };
  }

  return {
    consecutiveFrames: count,
    averageConfidence: Number((sumConfidence / count).toFixed(3)),
  };
}

function pruneStaleTracks(cameraState, now) {
  for (const [trackId, trackState] of cameraState.tracks.entries()) {
    if (now - asNumber(trackState.lastUpdatedAt, 0) > TRACK_TTL_MS) {
      cameraState.tracks.delete(trackId);
    }
  }
}

function trackPriorityScore(trackState, now) {
  const hasStableIdentity = Boolean(trackState.stableId);
  const isLocked = now < asNumber(trackState.lockUntil, 0);
  const confidence = asNumber(
    trackState.stableConfidence,
    asNumber(trackState.smoothedConfidence, asNumber(trackState.lastRawConfidence, 0))
  );
  const freshness = Math.max(
    0,
    Math.min(1, (TRACK_TTL_MS - (now - asNumber(trackState.lastUpdatedAt, 0))) / TRACK_TTL_MS)
  );

  return (
    (hasStableIdentity ? 2 : 0)
    + (isLocked ? 0.5 : 0)
    + confidence * 0.4
    + freshness * 0.2
  );
}

function enforceTrackLimit(cameraState, keepTrackId, now) {
  if (cameraState.tracks.size <= MAX_TRACKS_PER_CAMERA) {
    return;
  }

  const candidates = Array.from(cameraState.tracks.entries())
    .filter(([trackId]) => trackId !== keepTrackId)
    .map(([trackId, trackState]) => ({
      trackId,
      score: trackPriorityScore(trackState, now),
    }))
    .sort((a, b) => a.score - b.score);

  while (cameraState.tracks.size > MAX_TRACKS_PER_CAMERA && candidates.length > 0) {
    const dropped = candidates.shift();
    if (!dropped) {
      break;
    }

    cameraState.tracks.delete(dropped.trackId);
  }
}

function getOrCreateTrackState(cameraState, trackId, now) {
  const resolvedTrackId = toTrackKey(trackId);
  pruneStaleTracks(cameraState, now);

  if (!cameraState.tracks.has(resolvedTrackId)) {
    cameraState.tracks.set(resolvedTrackId, createTrackState(resolvedTrackId, now));
  }

  const trackState = cameraState.tracks.get(resolvedTrackId);
  trackState.lastUpdatedAt = now;

  enforceTrackLimit(cameraState, resolvedTrackId, now);

  return trackState;
}

function buildStableIdentities(cameraState, now) {
  return Array.from(cameraState.tracks.values())
    .map((trackState) => {
      const lockRemainingMs = Math.max(0, asNumber(trackState.lockUntil, 0) - now);
      const hasStableIdentity = Boolean(trackState.stableId);
      const status = hasStableIdentity
        ? (trackState.lastSwitchingSignal ? "switching" : "confirmed")
        : String(trackState.lastStatus || "detecting");

      return {
        trackId: trackState.trackId,
        status,
        stableId: trackState.stableId || null,
        stableName: trackState.stableName || null,
        confidence: Number(
          asNumber(
            trackState.stableConfidence,
            asNumber(trackState.smoothedConfidence, asNumber(trackState.lastRawConfidence, 0))
          ).toFixed(3)
        ),
        isLocked: lockRemainingMs > 0,
        isSwitching: Boolean(trackState.lastSwitchingSignal),
        switchingProgress: Number(asNumber(trackState.switchingProgress, 0).toFixed(3)),
        lockRemainingMs,
        lastUpdatedAt: new Date(asNumber(trackState.lastUpdatedAt, now)).toISOString(),
      };
    })
    .sort((left, right) => {
      const leftConfirmed = left.status === "confirmed" ? 1 : 0;
      const rightConfirmed = right.status === "confirmed" ? 1 : 0;
      if (rightConfirmed !== leftConfirmed) {
        return rightConfirmed - leftConfirmed;
      }

      if (right.isLocked !== left.isLocked) {
        return Number(right.isLocked) - Number(left.isLocked);
      }

      if (right.confidence !== left.confidence) {
        return right.confidence - left.confidence;
      }

      return new Date(right.lastUpdatedAt).getTime() - new Date(left.lastUpdatedAt).getTime();
    })
    .slice(0, MAX_TRACKS_PER_CAMERA);
}

function buildUiState({
  cameraState,
  trackState,
  status,
  switchingSignal,
  events,
  rawDetectedId,
  rawDetectedName,
  now,
} = {}) {
  const lockRemainingMs = Math.max(0, asNumber(trackState.lockUntil, 0) - now);
  const switchedNow = (Array.isArray(events) ? events : []).some(
    (entry) => String(entry?.type || "") === "identity_switched"
  );
  const isLocked = (status === "confirmed" || status === "switching") && lockRemainingMs > 0;
  const isSwitching = Boolean(switchingSignal || switchedNow || status === "switching");

  let phase = "looking";
  if (status === "lost") {
    phase = "lost";
  } else if (isSwitching) {
    phase = "switching";
  } else if (status === "confirmed" && isLocked) {
    phase = "locked";
  } else if (status === "confirmed") {
    phase = "recognizing";
  }

  let message = "Looking for face...";
  const stableLabel = String(trackState.stableName || trackState.stableId || "identity");

  if (phase === "switching") {
    const nextName = String(rawDetectedName || rawDetectedId || "candidate");
    message = `Switching to ${nextName}...`;
  } else if (phase === "locked") {
    message = `Locked on ${stableLabel}`;
  } else if (phase === "recognizing") {
    message = `Recognizing ${stableLabel}`;
  } else if (phase === "lost") {
    message = "Identity lost";
  }

  const phaseLegacy =
    phase === "looking"
      ? "detecting"
      : phase === "recognizing"
        ? "stable"
        : phase;

  const semanticConfidence = asNumber(
    trackState.stableConfidence,
    asNumber(trackState.smoothedConfidence, 0)
  );

  return {
    phase,
    phaseLegacy,
    label: message,
    message,
    confidenceLevel: confidenceLevel(semanticConfidence),
    trackId: trackState.trackId,
    cameraId: cameraState.cameraId,
    stableId: trackState.stableId || null,
    stableName: trackState.stableName || null,
    lockRemainingMs,
    isLocked,
    isSwitching,
    switchingProgress: Number(asNumber(trackState.switchingProgress, 0).toFixed(3)),
    transitions: {
      looking: phase === "looking",
      recognizing: phase === "recognizing",
      locked: phase === "locked",
      switching: phase === "switching",
      lost: phase === "lost",
      detecting: phase === "looking",
    },
    stableIdentities: buildStableIdentities(cameraState, now),
  };
}

function createOutput({
  cameraState,
  trackState,
  status,
  rawDetectedId,
  rawDetectedName,
  rawConfidence,
  consecutiveFrames,
  averageConfidence,
  confirmThreshold,
  switchingSignal,
  events,
  now,
  processingMs,
} = {}) {
  const lockRemainingMs = Math.max(0, asNumber(trackState.lockUntil, 0) - now);
  const stableId = trackState.stableId || null;
  const stableName = trackState.stableName || null;
  const confidence = status === "confirmed" || status === "switching"
    ? Number(asNumber(trackState.stableConfidence, asNumber(trackState.smoothedConfidence, 0)).toFixed(3))
    : Number(asNumber(rawConfidence, asNumber(trackState.smoothedConfidence, 0)).toFixed(3));
  const stableIdentities = buildStableIdentities(cameraState, now);
  const uiState = buildUiState({
    cameraState,
    trackState,
    status,
    switchingSignal,
    events,
    rawDetectedId,
    rawDetectedName,
    now,
  });

  const output = {
    cameraId: cameraState.cameraId,
    trackId: trackState.trackId,
    status,
    stableId,
    stableName,
    confidence,
    framesAnalyzed: trackState.frames.length,
    lockRemainingMs,
    consecutiveFrames,
    averageConfidence,
    confirmThreshold: Number(asNumber(confirmThreshold, CONFIRM_CONFIDENCE_THRESHOLD).toFixed(3)),
    shouldEmit:
      status === "confirmed"
      && Boolean(rawDetectedId)
      && String(rawDetectedId) === String(trackState.stableId || "")
      && !switchingSignal,
    activeTrackCount: cameraState.tracks.size,
    stableIdentities,
    uiState,
    events,
  };

  if (DEBUG_ENABLED) {
    output.predictionUsed = Boolean(trackState.lastPredictionUsed);
    output.motionDelta = Number(asNumber(trackState.movementDelta, 0).toFixed(3));
    output.smoothedConfidence = Number(asNumber(trackState.smoothedConfidence, 0).toFixed(3));
    output.switchingProgress = Number(asNumber(trackState.switchingProgress, 0).toFixed(3));
    output.activeTracks = cameraState.tracks.size;
    output.debug = {
      bufferSize: trackState.frames.length,
      consecutiveFrames,
      lockRemainingMs,
      adaptiveConfirmThreshold: Number(
        asNumber(confirmThreshold, CONFIRM_CONFIDENCE_THRESHOLD).toFixed(3)
      ),
      pipelineLatencyMs: Number(asNumber(trackState.lastPipelineLatencyMs, 0).toFixed(2)),
      switchingSignal: Boolean(switchingSignal),
      trackId: trackState.trackId,
      predictionUsed: Boolean(trackState.lastPredictionUsed),
      predictionMatched: Boolean(trackState.lastPredictionMatched),
      predictionMismatchFrames: asNumber(trackState.predictionMismatchFrames, 0),
      motionDelta: Number(asNumber(trackState.movementDelta, 0).toFixed(3)),
      smoothedConfidence: Number(asNumber(trackState.smoothedConfidence, 0).toFixed(3)),
      switchingProgress: Number(asNumber(trackState.switchingProgress, 0).toFixed(3)),
      activeTracks: cameraState.tracks.size,
      processingMs: Number(asNumber(processingMs, 0).toFixed(3)),
      performanceTargetMs: PERFORMANCE_TARGET_MS,
    };
  }

  return output;
}

function applyPerceptionHeuristics({
  trackState,
  rawDetectedId,
  rawConfidence,
  box,
  events,
} = {}) {
  const stableId = String(trackState.stableId || "");
  const hasStableIdentity = Boolean(stableId);
  const predictionMatch = Boolean(stableId && rawDetectedId && rawDetectedId === stableId);
  const predictionMismatch = Boolean(stableId && rawDetectedId && rawDetectedId !== stableId);

  let confidenceAdjustment = 0;
  let requiredConsecutiveFrames = CONSECUTIVE_MIN_FRAMES;
  let switchConfidenceMargin = 0;

  if (predictionMatch) {
    confidenceAdjustment += PREDICTION_CONFIDENCE_BOOST;
    requiredConsecutiveFrames = Math.max(2, CONSECUTIVE_MIN_FRAMES - 1);
    trackState.predictionMismatchFrames = 0;
  } else if (predictionMismatch) {
    confidenceAdjustment -= PREDICTION_MISMATCH_PENALTY;
    requiredConsecutiveFrames += 1;
    switchConfidenceMargin += 0.015;
    trackState.predictionMismatchFrames += 1;
  } else {
    trackState.predictionMismatchFrames = Math.max(0, trackState.predictionMismatchFrames - 1);
  }

  trackState.lastPredictionUsed = predictionMatch || predictionMismatch;
  trackState.lastPredictionMatched = predictionMatch;

  if (trackState.lastPredictionUsed) {
    events.push({
      type: "prediction_applied",
      message: predictionMatch
        ? `Prediction matched ${rawDetectedId}`
        : `Prediction mismatch for ${rawDetectedId}`,
      details: {
        trackId: trackState.trackId,
        expectedId: stableId || null,
        observedId: rawDetectedId || null,
        matched: predictionMatch,
        adjustment: Number(confidenceAdjustment.toFixed(3)),
      },
    });
  }

  const normalizedBox = normalizeBox(box);
  const currentCenter = centerFromBox(normalizedBox);
  const previousCenter = trackState.lastPosition;
  const movementDelta = Number(distanceBetweenPoints(currentCenter, previousCenter).toFixed(3));

  let motionBoost = 0;
  let motionPenalty = 0;
  let suddenJump = false;

  if (currentCenter) {
    if (previousCenter) {
      if (movementDelta <= MOTION_SMALL_SHIFT_PX) {
        motionBoost = hasStableIdentity ? MOTION_CONFIDENCE_BOOST : 0;
      } else if (movementDelta >= MOTION_LARGE_SHIFT_PX) {
        motionPenalty = MOTION_JUMP_PENALTY;
        suddenJump = true;
      }
    }

    trackState.lastPosition = currentCenter;
  }

  if (normalizedBox) {
    trackState.lastBox = normalizedBox;
  }

  trackState.movementDelta = movementDelta;

  if (motionBoost > 0 || motionPenalty > 0) {
    events.push({
      type: "motion_stability_boost",
      message: motionBoost > 0
        ? `Motion continuity boost applied (${movementDelta}px)`
        : `Motion jump penalty applied (${movementDelta}px)`,
      details: {
        trackId: trackState.trackId,
        movementDelta,
        motionBoost: Number(motionBoost.toFixed(3)),
        motionPenalty: Number(motionPenalty.toFixed(3)),
        suddenJump,
      },
    });
  }

  confidenceAdjustment += motionBoost;
  confidenceAdjustment -= motionPenalty;

  if (suddenJump) {
    requiredConsecutiveFrames += 1;
    switchConfidenceMargin += 0.03;
  }

  if (!hasStableIdentity) {
    requiredConsecutiveFrames += 1;
  }

  const adjustedConfidence = clamp(rawConfidence + confidenceAdjustment, 0, 1);
  const previousSmoothed = asNumber(trackState.smoothedConfidence, 0) > 0
    ? asNumber(trackState.smoothedConfidence, adjustedConfidence)
    : adjustedConfidence;
  const smoothedConfidence = clamp(
    previousSmoothed * (1 - CONFIDENCE_SMOOTHING_ALPHA)
      + adjustedConfidence * CONFIDENCE_SMOOTHING_ALPHA,
    0,
    1
  );

  trackState.smoothedConfidence = Number(smoothedConfidence.toFixed(3));

  if (Math.abs(trackState.smoothedConfidence - rawConfidence) >= 0.02) {
    events.push({
      type: "confidence_smoothed",
      message: "Confidence smoothing applied",
      details: {
        trackId: trackState.trackId,
        rawConfidence: Number(rawConfidence.toFixed(3)),
        adjustedConfidence: Number(adjustedConfidence.toFixed(3)),
        smoothedConfidence: Number(trackState.smoothedConfidence.toFixed(3)),
      },
    });
  }

  return {
    adjustedConfidence,
    smoothedConfidence: trackState.smoothedConfidence,
    predictionMismatch,
    predictionMatch,
    movementDelta,
    suddenJump,
    requiredConsecutiveFrames,
    switchConfidenceMargin,
  };
}

function updateSwitchCandidate(trackState, rawDetectedId, requiredSwitchFrames, now) {
  if (!rawDetectedId || rawDetectedId === String(trackState.stableId || "")) {
    resetSwitchCandidate(trackState);
    return {
      started: false,
      candidateFrames: 0,
      switchingProgress: 0,
    };
  }

  let started = false;

  if (trackState.switchCandidateId !== rawDetectedId) {
    trackState.switchCandidateId = rawDetectedId;
    trackState.switchCandidateFrames = 1;
    trackState.switchingStartedAt = now;
    started = true;
  } else {
    trackState.switchCandidateFrames += 1;
    if (!trackState.switchingStartedAt) {
      trackState.switchingStartedAt = now;
      started = true;
    }
  }

  trackState.switchingProgress = clamp(
    trackState.switchCandidateFrames / Math.max(1, requiredSwitchFrames),
    0,
    1
  );

  return {
    started,
    candidateFrames: trackState.switchCandidateFrames,
    switchingProgress: trackState.switchingProgress,
  };
}

function processFrame({
  cameraId,
  trackId,
  timestamp,
  detectedId,
  detectedName,
  confidence,
  pipelineLatencyMs,
  descriptorDrift,
  box,
} = {}) {
  const startedAt = hiResNowMs();
  const now = Number.isFinite(Number(timestamp)) ? Number(timestamp) : Date.now();
  const cameraState = getOrCreateCameraState(cameraId);
  cameraState.lastUpdatedAt = now;

  const trackState = getOrCreateTrackState(cameraState, trackId, now);
  const events = [];
  const rawDetectedId = String(detectedId || "").trim();
  const rawDetectedName = String(detectedName || "").trim();
  const rawConfidence = clamp(asNumber(confidence, 0), 0, 1);
  const observedDescriptorDrift = Math.max(0, asNumber(descriptorDrift, 0));
  const observedPipelineLatencyMs = Math.max(0, asNumber(pipelineLatencyMs, 0));

  function finalize(payload) {
    const processingMs = hiResNowMs() - startedAt;
    return createOutput({
      ...payload,
      processingMs,
    });
  }

  trackState.lastUpdatedAt = now;
  trackState.lastPipelineLatencyMs = observedPipelineLatencyMs;
  trackState.lastRawConfidence = rawConfidence;

  const adaptiveConfirmThreshold = clamp(
    CONFIRM_CONFIDENCE_THRESHOLD
      + (observedPipelineLatencyMs >= ADAPTIVE_LATENCY_THRESHOLD_MS
        ? ADAPTIVE_THRESHOLD_BOOST
        : 0),
    0.4,
    0.99
  );

  if (trackState.stableId) {
    trackState.stableConfidence = Number(
      Math.max(
        STABLE_CONFIDENCE_MIN,
        asNumber(trackState.stableConfidence, 0) * STABLE_CONFIDENCE_DECAY
      ).toFixed(3)
    );
  }

  if (!rawDetectedId) {
    pushFrame(trackState, {
      timestamp: new Date(now).toISOString(),
      detectedId: null,
      confidence: Number(Math.max(0, asNumber(trackState.smoothedConfidence, 0) * 0.8).toFixed(3)),
    });

    const hadStableIdentity = Boolean(trackState.stableId);
    const graceBlockedByDrift = observedDescriptorDrift >= NO_DETECTION_MAX_DRIFT;
    const graceActive =
      hadStableIdentity
      && trackState.lastDetectionAt > 0
      && now - trackState.lastDetectionAt < NO_DETECTION_GRACE_MS
      && !graceBlockedByDrift;

    if (hadStableIdentity && graceBlockedByDrift) {
      events.push({
        type: "identity_lost",
        message: `Identity ${trackState.stableId} dropped due to descriptor drift`,
        details: {
          previousId: trackState.stableId,
          descriptorDrift: Number(observedDescriptorDrift.toFixed(4)),
          maxGraceDrift: NO_DETECTION_MAX_DRIFT,
          trackId: trackState.trackId,
        },
      });

      clearIdentity(trackState);
      trackState.lastStatus = "lost";
      trackState.lastSwitchingSignal = false;

      return finalize({
        cameraState,
        trackState,
        status: "lost",
        rawDetectedId,
        rawDetectedName,
        rawConfidence,
        consecutiveFrames: 0,
        averageConfidence: 0,
        confirmThreshold: adaptiveConfirmThreshold,
        switchingSignal: false,
        events,
        now,
      });
    }

    if (graceActive) {
      trackState.lastStatus = "confirmed";
      trackState.lastSwitchingSignal = false;
      trackState.predictionMismatchFrames = Math.max(0, trackState.predictionMismatchFrames - 1);
      resetSwitchCandidate(trackState);
      return finalize({
        cameraState,
        trackState,
        status: "confirmed",
        rawDetectedId,
        rawDetectedName,
        rawConfidence,
        consecutiveFrames: 0,
        averageConfidence: 0,
        confirmThreshold: adaptiveConfirmThreshold,
        switchingSignal: false,
        events,
        now,
      });
    }

    if (hadStableIdentity) {
      events.push({
        type: "identity_lost",
        message: `Identity ${trackState.stableId} lost after no-detection grace period`,
        details: {
          previousId: trackState.stableId,
          graceMs: NO_DETECTION_GRACE_MS,
          trackId: trackState.trackId,
        },
      });

      clearIdentity(trackState);
      trackState.lastStatus = "lost";
      trackState.lastSwitchingSignal = false;

      return finalize({
        cameraState,
        trackState,
        status: "lost",
        rawDetectedId,
        rawDetectedName,
        rawConfidence,
        consecutiveFrames: 0,
        averageConfidence: 0,
        confirmThreshold: adaptiveConfirmThreshold,
        switchingSignal: false,
        events,
        now,
      });
    }

    trackState.lastStatus = "detecting";
    trackState.lastSwitchingSignal = false;
    resetSwitchCandidate(trackState);

    return finalize({
      cameraState,
      trackState,
      status: "detecting",
      rawDetectedId,
      rawDetectedName,
      rawConfidence,
      consecutiveFrames: 0,
      averageConfidence: 0,
      confirmThreshold: adaptiveConfirmThreshold,
      switchingSignal: false,
      events,
      now,
    });
  }

  trackState.lastDetectionAt = now;

  const heuristics = applyPerceptionHeuristics({
    trackState,
    rawDetectedId,
    rawConfidence,
    box,
    events,
  });

  pushFrame(trackState, {
    timestamp: new Date(now).toISOString(),
    detectedId: rawDetectedId,
    confidence: heuristics.smoothedConfidence,
  });

  const run = trailingRunForId(trackState.frames, rawDetectedId);
  const requiredConsecutiveFrames = Math.max(2, heuristics.requiredConsecutiveFrames);
  const stableThreshold = clamp(
    adaptiveConfirmThreshold + (heuristics.predictionMismatch ? 0.01 : 0),
    0.4,
    0.99
  );
  const isCandidateStable =
    run.consecutiveFrames >= requiredConsecutiveFrames
    && run.averageConfidence >= stableThreshold;

  const lockActive = Boolean(trackState.lockedId) && now < asNumber(trackState.lockUntil, 0);

  if (lockActive && trackState.lockedId) {
    if (rawDetectedId !== String(trackState.stableId || "")) {
      const requiredSwitchFrames = Math.max(
        CONSECUTIVE_MIN_FRAMES + 1,
        requiredConsecutiveFrames + 1
      );
      const switchProgressState = updateSwitchCandidate(
        trackState,
        rawDetectedId,
        requiredSwitchFrames,
        now
      );

      if (switchProgressState.started) {
        events.push({
          type: "switching_started",
          message: `Switching started from ${trackState.stableId} to ${rawDetectedId}`,
          details: {
            fromId: trackState.stableId,
            toId: rawDetectedId,
            trackId: trackState.trackId,
            requiredFrames: requiredSwitchFrames,
          },
        });
      }

      trackState.lastStatus = "switching";
      trackState.lastSwitchingSignal = true;

      return finalize({
        cameraState,
        trackState,
        status: "switching",
        rawDetectedId,
        rawDetectedName,
        rawConfidence: heuristics.smoothedConfidence,
        consecutiveFrames: run.consecutiveFrames,
        averageConfidence: run.averageConfidence,
        confirmThreshold: adaptiveConfirmThreshold,
        switchingSignal: true,
        events,
        now,
      });
    }

    resetSwitchCandidate(trackState);
    trackState.lastStatus = "confirmed";
    trackState.lastSwitchingSignal = false;

    if (run.averageConfidence > 0) {
      trackState.stableConfidence = Number(
        (
          asNumber(trackState.stableConfidence, run.averageConfidence) * 0.6
          + run.averageConfidence * 0.4
        ).toFixed(3)
      );
    }

    if (rawDetectedName) {
      trackState.stableName = rawDetectedName;
    }

    return finalize({
      cameraState,
      trackState,
      status: "confirmed",
      rawDetectedId,
      rawDetectedName,
      rawConfidence: heuristics.smoothedConfidence,
      consecutiveFrames: run.consecutiveFrames,
      averageConfidence: run.averageConfidence,
      confirmThreshold: adaptiveConfirmThreshold,
      switchingSignal: false,
      events,
      now,
    });
  }

  if (!trackState.stableId) {
    if (isCandidateStable) {
      trackState.stableId = rawDetectedId;
      trackState.stableName = rawDetectedName || trackState.stableName;
      trackState.stableConfidence = run.averageConfidence;
      trackState.lockedId = rawDetectedId;
      trackState.lockUntil = now + LOCK_MS;
      resetSwitchCandidate(trackState);

      events.push({
        type: "identity_confirmed",
        message: `Identity ${rawDetectedId} confirmed`,
        details: {
          stableId: rawDetectedId,
          confidence: run.averageConfidence,
          consecutiveFrames: run.consecutiveFrames,
          threshold: stableThreshold,
          adaptiveBoostApplied:
            observedPipelineLatencyMs >= ADAPTIVE_LATENCY_THRESHOLD_MS,
          trackId: trackState.trackId,
        },
      });
      events.push({
        type: "stability_locked",
        message: `Identity ${rawDetectedId} locked for ${LOCK_MS}ms`,
        details: {
          stableId: rawDetectedId,
          lockMs: LOCK_MS,
          trackId: trackState.trackId,
        },
      });

      trackState.lastStatus = "confirmed";
      trackState.lastSwitchingSignal = false;

      return finalize({
        cameraState,
        trackState,
        status: "confirmed",
        rawDetectedId,
        rawDetectedName,
        rawConfidence: heuristics.smoothedConfidence,
        consecutiveFrames: run.consecutiveFrames,
        averageConfidence: run.averageConfidence,
        confirmThreshold: adaptiveConfirmThreshold,
        switchingSignal: false,
        events,
        now,
      });
    }

    trackState.lastStatus = "detecting";
    trackState.lastSwitchingSignal = false;

    return finalize({
      cameraState,
      trackState,
      status: "detecting",
      rawDetectedId,
      rawDetectedName,
      rawConfidence: heuristics.smoothedConfidence,
      consecutiveFrames: run.consecutiveFrames,
      averageConfidence: run.averageConfidence,
      confirmThreshold: adaptiveConfirmThreshold,
      switchingSignal: false,
      events,
      now,
    });
  }

  if (rawDetectedId === trackState.stableId) {
    if (run.averageConfidence > 0) {
      trackState.stableConfidence = Number(
        (
          asNumber(trackState.stableConfidence, run.averageConfidence) * 0.55
          + run.averageConfidence * 0.45
        ).toFixed(3)
      );
    }

    if (rawDetectedName) {
      trackState.stableName = rawDetectedName;
    }

    resetSwitchCandidate(trackState);
    trackState.lastStatus = "confirmed";
    trackState.lastSwitchingSignal = false;

    return finalize({
      cameraState,
      trackState,
      status: "confirmed",
      rawDetectedId,
      rawDetectedName,
      rawConfidence: heuristics.smoothedConfidence,
      consecutiveFrames: run.consecutiveFrames,
      averageConfidence: run.averageConfidence,
      confirmThreshold: adaptiveConfirmThreshold,
      switchingSignal: false,
      events,
      now,
    });
  }

  const currentConfidence = asNumber(trackState.stableConfidence, 0);
  const requiredSwitchFrames = Math.max(
    CONSECUTIVE_MIN_FRAMES + 1,
    requiredConsecutiveFrames
  );
  const switchProgressState = updateSwitchCandidate(
    trackState,
    rawDetectedId,
    requiredSwitchFrames,
    now
  );

  if (switchProgressState.started) {
    events.push({
      type: "switching_started",
      message: `Switching started from ${trackState.stableId} to ${rawDetectedId}`,
      details: {
        fromId: trackState.stableId,
        toId: rawDetectedId,
        trackId: trackState.trackId,
        requiredFrames: requiredSwitchFrames,
      },
    });
  }

  const predictionMismatchPersistent =
    trackState.predictionMismatchFrames >= PREDICTION_SWITCH_PERSIST_FRAMES;
  const candidateSwitchStable =
    run.consecutiveFrames >= requiredSwitchFrames
    && run.averageConfidence >= clamp(stableThreshold + 0.02, 0.4, 0.99);

  const dynamicSwitchDelta = predictionMismatchPersistent
    ? Math.max(0.04, SWITCH_CONFIDENCE_DELTA * 0.45)
    : SWITCH_CONFIDENCE_DELTA;

  const switchMargin =
    dynamicSwitchDelta
    + heuristics.switchConfidenceMargin;

  const canSwitch =
    predictionMismatchPersistent
    && candidateSwitchStable
    && run.averageConfidence > currentConfidence + switchMargin;

  if (canSwitch) {
    const previousId = trackState.stableId;

    trackState.stableId = rawDetectedId;
    trackState.stableName = rawDetectedName || trackState.stableName;
    trackState.stableConfidence = run.averageConfidence;
    trackState.lockedId = rawDetectedId;
    trackState.lockUntil = now + LOCK_MS;

    events.push({
      type: "identity_switched",
      message: `Identity switched from ${previousId} to ${rawDetectedId}`,
      details: {
        fromId: previousId,
        toId: rawDetectedId,
        previousConfidence: currentConfidence,
        newConfidence: run.averageConfidence,
        requiredDelta: switchMargin,
        adaptiveConfirmThreshold,
        predictionMismatchFrames: trackState.predictionMismatchFrames,
        trackId: trackState.trackId,
      },
    });
    events.push({
      type: "switching_completed",
      message: `Switching completed to ${rawDetectedId}`,
      details: {
        fromId: previousId,
        toId: rawDetectedId,
        trackId: trackState.trackId,
        switchingFrames: trackState.switchCandidateFrames,
      },
    });
    events.push({
      type: "stability_locked",
      message: `Identity ${rawDetectedId} locked for ${LOCK_MS}ms`,
      details: {
        stableId: rawDetectedId,
        lockMs: LOCK_MS,
        trackId: trackState.trackId,
      },
    });

    resetSwitchCandidate(trackState);
    trackState.lastStatus = "confirmed";
    trackState.lastSwitchingSignal = false;

    return finalize({
      cameraState,
      trackState,
      status: "confirmed",
      rawDetectedId,
      rawDetectedName,
      rawConfidence: heuristics.smoothedConfidence,
      consecutiveFrames: run.consecutiveFrames,
      averageConfidence: run.averageConfidence,
      confirmThreshold: adaptiveConfirmThreshold,
      switchingSignal: false,
      events,
      now,
    });
  }

  trackState.lastStatus = "switching";
  trackState.lastSwitchingSignal = true;

  return finalize({
    cameraState,
    trackState,
    status: "switching",
    rawDetectedId,
    rawDetectedName,
    rawConfidence: heuristics.smoothedConfidence,
    consecutiveFrames: run.consecutiveFrames,
    averageConfidence: run.averageConfidence,
    confirmThreshold: adaptiveConfirmThreshold,
    switchingSignal: true,
    events,
    now,
  });
}

function getStabilityHealthSummary() {
  let activeTracks = 0;
  for (const cameraState of cameraBuffers.values()) {
    activeTracks += cameraState.tracks.size;
  }

  return {
    camerasTracked: cameraBuffers.size,
    activeTracks,
    config: {
      bufferSize: BUFFER_SIZE,
      consecutiveFrames: CONSECUTIVE_MIN_FRAMES,
      confidenceThreshold: CONFIRM_CONFIDENCE_THRESHOLD,
      lockMs: LOCK_MS,
      switchDelta: SWITCH_CONFIDENCE_DELTA,
      adaptiveLatencyThresholdMs: ADAPTIVE_LATENCY_THRESHOLD_MS,
      adaptiveThresholdBoost: ADAPTIVE_THRESHOLD_BOOST,
      confidenceDecay: STABLE_CONFIDENCE_DECAY,
      confidenceMin: STABLE_CONFIDENCE_MIN,
      noDetectionGraceMs: NO_DETECTION_GRACE_MS,
      noDetectionMaxDrift: NO_DETECTION_MAX_DRIFT,
      trackSlotsPerCamera: MAX_TRACKS_PER_CAMERA,
      trackTtlMs: TRACK_TTL_MS,
      predictionBoost: PREDICTION_CONFIDENCE_BOOST,
      predictionMismatchPenalty: PREDICTION_MISMATCH_PENALTY,
      predictionSwitchPersistFrames: PREDICTION_SWITCH_PERSIST_FRAMES,
      motionSmallShiftPx: MOTION_SMALL_SHIFT_PX,
      motionLargeShiftPx: MOTION_LARGE_SHIFT_PX,
      motionBoost: MOTION_CONFIDENCE_BOOST,
      motionJumpPenalty: MOTION_JUMP_PENALTY,
      smoothingAlpha: CONFIDENCE_SMOOTHING_ALPHA,
      performanceTargetMs: PERFORMANCE_TARGET_MS,
      debug: DEBUG_ENABLED,
    },
  };
}

module.exports = {
  processFrame,
  getStabilityHealthSummary,
};