const MAX_CAMERAS = Math.max(20, Math.min(300, Number(process.env.OMNI_CAMERA_TRACK_SIZE || 120)));

const state = {
  totalDetections: 0,
  successfulMatches: 0,
  failedMatches: 0,
  latencyTotalMs: 0,
  latencySamples: 0,
  lastDetectionTime: null,
  cameras: new Map(),
};

function asNumberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function ensureCamera(cameraId) {
  const key = String(cameraId || "unknown-camera").trim() || "unknown-camera";

  if (!state.cameras.has(key)) {
    if (state.cameras.size >= MAX_CAMERAS) {
      const oldestKey = state.cameras.keys().next().value;
      if (oldestKey) {
        state.cameras.delete(oldestKey);
      }
    }

    state.cameras.set(key, {
      cameraId: key,
      connected: false,
      lastSeenAt: 0,
      lastUpdate: null,
    });
  }

  return state.cameras.get(key);
}

function touchCamera(cameraId, options = {}) {
  const camera = ensureCamera(cameraId);
  const now = Number(options.now || Date.now());
  if (Number.isFinite(now) && now > 0) {
    camera.lastSeenAt = now;
    camera.lastUpdate = new Date(now).toISOString();
  }

  if (options.connected !== undefined) {
    camera.connected = Boolean(options.connected);
  }

  return camera;
}

function recordCameraConnected(cameraId) {
  touchCamera(cameraId, {
    connected: true,
    now: Date.now(),
  });
}

function recordCameraDisconnected(cameraId) {
  touchCamera(cameraId, {
    connected: false,
    now: Date.now(),
  });
}

function recordDetection({ cameraId, matched, totalLatencyMs } = {}) {
  state.totalDetections += 1;

  if (matched) {
    state.successfulMatches += 1;
  } else {
    state.failedMatches += 1;
  }

  const latency = asNumberOrNull(totalLatencyMs);
  if (latency !== null) {
    state.latencyTotalMs += latency;
    state.latencySamples += 1;
  }

  const now = Date.now();
  state.lastDetectionTime = new Date(now).toISOString();
  touchCamera(cameraId, {
    connected: true,
    now,
  });
}

function getAverageLatency() {
  if (state.latencySamples <= 0) {
    return 0;
  }

  return Number((state.latencyTotalMs / state.latencySamples).toFixed(2));
}

function getCameraSnapshots() {
  return Array.from(state.cameras.values()).map((entry) => ({ ...entry }));
}

function getStats() {
  return {
    totalDetections: state.totalDetections,
    successfulMatches: state.successfulMatches,
    failedMatches: state.failedMatches,
    avgLatency: getAverageLatency(),
  };
}

function getLastDetectionTime() {
  return state.lastDetectionTime;
}

module.exports = {
  recordCameraConnected,
  recordCameraDisconnected,
  touchCamera,
  recordDetection,
  getCameraSnapshots,
  getStats,
  getAverageLatency,
  getLastDetectionTime,
};
