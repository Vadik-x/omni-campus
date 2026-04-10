const logger = require("./logger");

const MAX_ALERTS = Math.max(20, Math.min(500, Number(process.env.OMNI_ALERT_BUFFER_SIZE || 120)));
const ALERT_DEDUP_MS = Math.max(2000, Number(process.env.OMNI_ALERT_DEDUP_MS || 15000));
const NO_DETECTION_ALERT_MS = Math.max(
  30000,
  Number(process.env.OMNI_NO_DETECTION_ALERT_MS || 180000)
);
const CAMERA_INACTIVE_ALERT_MS = Math.max(
  30000,
  Number(process.env.OMNI_CAMERA_INACTIVE_ALERT_MS || 120000)
);
const LATENCY_WARN_MS = Math.max(50, Number(process.env.OMNI_LATENCY_WARN_MS || 500));
const LOW_CONFIDENCE_THRESHOLD = Number(process.env.OMNI_LOW_CONFIDENCE_THRESHOLD || 0.55);
const BOOT_AT_MS = Date.now();

const alerts = [];
const lastAlertByKey = new Map();

function asNumberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function pushAlert(alert) {
  alerts.push(alert);
  if (alerts.length > MAX_ALERTS) {
    alerts.shift();
  }
}

function canEmitAlert(key) {
  const now = Date.now();
  const last = Number(lastAlertByKey.get(key) || 0);

  if (now - last < ALERT_DEDUP_MS) {
    return false;
  }

  lastAlertByKey.set(key, now);
  return true;
}

function createAlert({
  type = "runtime_warning",
  message = "Warning",
  cameraId,
  latencyMs,
  confidence,
  details,
  dedupeKey,
} = {}) {
  const key = String(dedupeKey || `${type}:${cameraId || "global"}`);
  if (!canEmitAlert(key)) {
    return null;
  }

  const alert = {
    timestamp: new Date().toISOString(),
    level: "WARN",
    type: String(type || "runtime_warning"),
    cameraId: String(cameraId || ""),
    latencyMs: asNumberOrNull(latencyMs),
    confidence: asNumberOrNull(confidence),
    message: String(message || "Warning"),
    details: details && typeof details === "object" ? details : undefined,
  };

  pushAlert(alert);
  const logService = alert.type.startsWith("camera") ? "camera" : "recognition";
  logger.warn({
    service: logService,
    event: alert.type,
    cameraId: alert.cameraId,
    latencyMs: alert.latencyMs,
    confidence: alert.confidence,
    message: alert.message,
    details: alert.details,
  });

  return alert;
}

function evaluateDetectionWarnings({ cameraId, totalLatencyMs, confidence, confidenceThreshold } = {}) {
  const latency = asNumberOrNull(totalLatencyMs);
  const normalizedConfidence = asNumberOrNull(confidence);
  const threshold = Number.isFinite(Number(confidenceThreshold))
    ? Number(confidenceThreshold)
    : LOW_CONFIDENCE_THRESHOLD;

  if (latency !== null && latency > LATENCY_WARN_MS) {
    createAlert({
      type: "high_latency",
      cameraId,
      latencyMs: latency,
      confidence: normalizedConfidence,
      message: `High latency detected (${latency.toFixed(1)} ms)`,
      details: {
        thresholdMs: LATENCY_WARN_MS,
      },
      dedupeKey: `high_latency:${cameraId || "unknown-camera"}`,
    });
  }

  if (normalizedConfidence !== null && normalizedConfidence < threshold) {
    createAlert({
      type: "low_confidence",
      cameraId,
      latencyMs: latency,
      confidence: normalizedConfidence,
      message: `Low confidence detection (${normalizedConfidence.toFixed(3)})`,
      details: {
        threshold,
      },
      dedupeKey: `low_confidence:${cameraId || "unknown-camera"}`,
    });
  }
}

function checkNoDetections(lastDetectionIso) {
  const now = Date.now();
  const detectionTime = lastDetectionIso ? new Date(lastDetectionIso).getTime() : 0;

  if (!detectionTime || Number.isNaN(detectionTime)) {
    if (now - BOOT_AT_MS <= NO_DETECTION_ALERT_MS) {
      return;
    }

    createAlert({
      type: "no_detections",
      message: "No detections have been recorded yet",
      dedupeKey: "no_detections:never",
      details: {
        thresholdMs: NO_DETECTION_ALERT_MS,
      },
    });
    return;
  }

  const idleMs = now - detectionTime;
  if (idleMs > NO_DETECTION_ALERT_MS) {
    createAlert({
      type: "no_detections",
      message: `No detections in ${(idleMs / 1000).toFixed(0)} seconds`,
      latencyMs: idleMs,
      dedupeKey: "no_detections:stale",
      details: {
        thresholdMs: NO_DETECTION_ALERT_MS,
      },
    });
  }
}

function checkCameraInactivity(cameraEntries = []) {
  const now = Date.now();

  cameraEntries.forEach((camera) => {
    const cameraId = String(camera?.cameraId || "");
    if (!cameraId) {
      return;
    }

    const connected = Boolean(camera?.connected);
    if (!connected) {
      return;
    }

    const lastSeenAt = Number(camera?.lastSeenAt || 0);
    if (!lastSeenAt || Number.isNaN(lastSeenAt)) {
      return;
    }

    const idleMs = now - lastSeenAt;
    if (idleMs > CAMERA_INACTIVE_ALERT_MS) {
      createAlert({
        type: "camera_inactive",
        cameraId,
        latencyMs: idleMs,
        message: `Camera inactive for ${(idleMs / 1000).toFixed(0)} seconds`,
        details: {
          thresholdMs: CAMERA_INACTIVE_ALERT_MS,
        },
        dedupeKey: `camera_inactive:${cameraId}`,
      });
    }
  });
}

function getRecentAlerts(limit = 50) {
  if (alerts.length === 0) {
    return [];
  }

  const normalizedLimit = Math.max(1, Math.min(alerts.length, Number(limit) || 50));
  return alerts.slice(-normalizedLimit).reverse();
}

module.exports = {
  createAlert,
  evaluateDetectionWarnings,
  checkNoDetections,
  checkCameraInactivity,
  getRecentAlerts,
  config: {
    NO_DETECTION_ALERT_MS,
    CAMERA_INACTIVE_ALERT_MS,
    LATENCY_WARN_MS,
    LOW_CONFIDENCE_THRESHOLD,
  },
};
