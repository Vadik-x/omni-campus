const DEBUG_ENABLED = String(process.env.DEBUG || "false").toLowerCase() === "true";

function asString(value, fallback = "") {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function asNumberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeLevel(level) {
  const normalized = asString(level, "INFO").toUpperCase();
  if (["DEBUG", "INFO", "WARN", "ERROR"].includes(normalized)) {
    return normalized;
  }

  return "INFO";
}

function baseEntry({
  level = "INFO",
  service = "api",
  event = "event",
  cameraId,
  latencyMs,
  confidence,
  message = "",
} = {}) {
  return {
    timestamp: new Date().toISOString(),
    level: normalizeLevel(level),
    service: asString(service, "api"),
    event: asString(event, "event"),
    cameraId: asString(cameraId, null),
    latencyMs: asNumberOrNull(latencyMs),
    confidence: asNumberOrNull(confidence),
    message: asString(message, ""),
  };
}

function write(entry) {
  const line = `${JSON.stringify(entry)}\n`;

  if (entry.level === "ERROR") {
    process.stderr.write(line);
    return;
  }

  process.stdout.write(line);
}

function log(level, payload = {}) {
  const normalizedLevel = normalizeLevel(level);
  if (normalizedLevel === "DEBUG" && !DEBUG_ENABLED) {
    return;
  }

  const entry = baseEntry({
    ...payload,
    level: normalizedLevel,
  });

  const details = payload?.details;
  if (details !== undefined && (DEBUG_ENABLED || normalizedLevel === "ERROR")) {
    entry.details = details;
  }

  if (payload?.stack) {
    entry.stack = String(payload.stack);
  }

  write(entry);
}

function debug(payload = {}) {
  log("DEBUG", payload);
}

function info(payload = {}) {
  log("INFO", payload);
}

function warn(payload = {}) {
  log("WARN", payload);
}

function error(payload = {}) {
  const err = payload?.error;

  log("ERROR", {
    ...payload,
    message: payload?.message || err?.message || "Unexpected error",
    stack: payload?.stack || err?.stack,
    details: payload?.details || (DEBUG_ENABLED && err ? { name: err.name } : undefined),
  });
}

module.exports = {
  debug,
  info,
  warn,
  error,
  isDebugEnabled: () => DEBUG_ENABLED,
};
