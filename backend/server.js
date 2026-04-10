require("dotenv").config();

const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");

const createStudentsRouter = require("./routes/students");
const createTrackingRouter = require("./routes/tracking");
const createRecognitionRouter = require("./routes/recognition");
const cameraRoutes = require("./routes/camera");
const studentStore = require("./services/studentStore");
const security = require("./services/security");
const auditLog = require("./services/auditLog");
const logger = require("./services/logger");
const runtimeMetrics = require("./services/runtimeMetrics");
const runtimeAlerts = require("./services/runtimeAlerts");
const runtimeStats = require("./services/runtimeStats");

const app = express();
const server = http.createServer(app);
const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
const activeCameras = new Map();
const camerasBySocket = new Map();
const ALERT_CHECK_INTERVAL_MS = Math.max(
  10000,
  Number(process.env.OMNI_ALERT_CHECK_INTERVAL_MS || 20000)
);

let alertCheckTimer = null;

const io = new Server(server, {
  cors: {
    origin: frontendUrl,
    methods: ["GET", "POST", "PATCH", "DELETE"],
  },
});

app.use(
  cors({
    origin: frontendUrl,
    credentials: true,
  })
);

app.use(express.json({ limit: "10mb" }));

function getLastDetectionTime() {
  return runtimeMetrics.getLastDetectionTime() || runtimeStats.getLastDetectionTime() || null;
}

function getAverageLatency() {
  const metricsAverage = Number(runtimeMetrics.getAverageLatency() || 0);
  if (Number.isFinite(metricsAverage) && metricsAverage > 0) {
    return metricsAverage;
  }

  return Number(runtimeStats.getAverageLatency() || 0);
}

function getCameraHealthEntries() {
  const fromStats = runtimeStats.getCameraSnapshots();
  const byCameraId = new Map(fromStats.map((entry) => [String(entry.cameraId || ""), entry]));

  activeCameras.forEach((camera) => {
    const cameraId = String(camera?.cameraId || "");
    if (!cameraId) {
      return;
    }

    const timestamp = camera?.timestamp ? new Date(camera.timestamp).getTime() : Date.now();
    const existing = byCameraId.get(cameraId) || {
      cameraId,
      connected: true,
      lastSeenAt: timestamp,
      lastUpdate: camera.timestamp || new Date().toISOString(),
    };

    byCameraId.set(cameraId, {
      ...existing,
      connected: true,
      lastSeenAt: Number.isFinite(timestamp) ? timestamp : existing.lastSeenAt,
      lastUpdate: camera.timestamp || existing.lastUpdate,
    });
  });

  return Array.from(byCameraId.values());
}

function getHealthPayload() {
  const storeInfo = studentStore.getStoreInfo();
  return {
    status: "ok",
    uptime: Number(process.uptime().toFixed(2)),
    memoryUsage: process.memoryUsage(),
    lastDetectionTime: getLastDetectionTime(),
    avgLatency: getAverageLatency(),
    mode: storeInfo.mode,
    db: storeInfo.dbFile,
    students: studentStore.countStudents(),
    security: security.getSecuritySummary(),
  };
}

app.get("/health", (req, res) => {
  return res.json(getHealthPayload());
});

app.get("/api/health", (req, res) => {
  return res.json(getHealthPayload());
});

app.get("/api/alerts", (req, res) => {
  const limit = Number(req.query?.limit || 50);
  return res.json({
    items: runtimeAlerts.getRecentAlerts(limit),
  });
});

app.get("/api/stats", (req, res) => {
  const stats = runtimeStats.getStats();
  return res.json({
    ...stats,
    avgLatency: getAverageLatency(),
    lastDetectionTime: getLastDetectionTime(),
  });
});

app.use("/api/students", createStudentsRouter(io));
app.use("/api/tracking", createTrackingRouter(io));
app.use("/api/recognition", createRecognitionRouter(io));
app.use("/api/proxy", cameraRoutes);

app.use((req, res) => {
  res.status(404).json({ message: "Route not found" });
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  logger.error({
    service: "api",
    event: "api.unhandled_error",
    cameraId: String(req?.body?.cameraId || req?.query?.cameraId || ""),
    message: "Unhandled API error",
    error,
    details: {
      method: req?.method,
      path: req?.originalUrl || req?.url,
    },
  });

  runtimeAlerts.createAlert({
    type: "api_error",
    cameraId: String(req?.body?.cameraId || req?.query?.cameraId || ""),
    message: `API error on ${req?.method || "UNKNOWN"} ${req?.originalUrl || req?.url || ""}`,
    details: {
      message: error?.message || "Unknown error",
    },
    dedupeKey: `api_error:${req?.method || "UNKNOWN"}:${req?.originalUrl || req?.url || ""}`,
  });

  if (error.name === "ValidationError") {
    return res.status(400).json({
      message: "Validation failed",
      details: Object.values(error.errors).map((e) => e.message),
    });
  }

  return res.status(500).json({
    message: "Internal server error",
    details: process.env.NODE_ENV === "development" ? error.message : undefined,
  });
});

function getCameraList() {
  return Array.from(activeCameras.values()).map((camera) => ({
    cameraId: camera.cameraId,
    cameraLabel: camera.cameraLabel,
    source: camera.source,
    timestamp: camera.timestamp,
  }));
}

function broadcastCameraList() {
  io.emit("cameras:list", getCameraList());
}

function parseEventTimestamp(value) {
  const parsed = value ? new Date(value) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function clampConfidence(value) {
  if (typeof value !== "number") {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

function resolveCameraLabel(cameraId, providedLabel) {
  const incomingLabel = String(providedLabel || "").trim();
  if (incomingLabel) {
    return incomingLabel;
  }

  const key = String(cameraId || "").trim();
  if (!key) {
    return "Unknown Camera";
  }

  const active = activeCameras.get(key);
  if (active?.cameraLabel) {
    return String(active.cameraLabel);
  }

  return "Unknown Camera";
}

function applyFaceDetection(payload) {
  const eventTime = parseEventTimestamp(payload.timestamp);
  const cameraId = String(payload.cameraId || "unknown-camera");
  const cameraLabel = resolveCameraLabel(cameraId, payload.cameraLabel);

  const activeCamera = activeCameras.get(cameraId);
  if (activeCamera) {
    activeCameras.set(cameraId, {
      ...activeCamera,
      timestamp: eventTime.toISOString(),
    });
  }

  runtimeStats.recordDetection({
    cameraId,
    matched: true,
    totalLatencyMs: payload.latencyMs,
  });

  runtimeMetrics.recordMetricEvent({
    timestamp: eventTime.toISOString(),
    cameraId,
    ingest_to_detect_ms: null,
    detect_to_match_ms: null,
    total_latency_ms: Number.isFinite(Number(payload.latencyMs)) ? Number(payload.latencyMs) : null,
    match_confidence: clampConfidence(payload.confidence),
    matched: true,
    source: "socket_detection",
  });

  return studentStore.applyFaceDetection({
    studentId: payload.studentId,
    studentName: payload.studentName,
    cameraId,
    cameraLabel,
    timestamp: eventTime,
  });
}

function removeCamera(cameraId, socketId) {
  if (!cameraId) {
    return false;
  }

  const existing = activeCameras.get(cameraId);
  if (!existing) {
    return false;
  }

  if (socketId && existing.socketId !== socketId) {
    return false;
  }

  activeCameras.delete(cameraId);

  const owned = camerasBySocket.get(existing.socketId);
  if (owned) {
    owned.delete(cameraId);
    if (owned.size === 0) {
      camerasBySocket.delete(existing.socketId);
    }
  }

  return true;
}

function runAlertChecks() {
  try {
    runtimeAlerts.checkNoDetections(getLastDetectionTime());
    runtimeAlerts.checkCameraInactivity(getCameraHealthEntries());
  } catch (error) {
    logger.error({
      service: "api",
      event: "alerts.check_failed",
      message: "Background alert check failed",
      error,
    });
  }
}

function startAlertMonitor() {
  if (alertCheckTimer) {
    clearInterval(alertCheckTimer);
  }

  alertCheckTimer = setInterval(runAlertChecks, ALERT_CHECK_INTERVAL_MS);
}

io.on("connection", (socket) => {
  logger.info({
    service: "api",
    event: "socket.connected",
    message: `Socket connected: ${socket.id}`,
  });

  const socketActor = security.resolveActorFromSocket(socket);

  const socketRequestMeta = {
    method: "SOCKET",
    path: "face:detected",
    ip: String(socket?.handshake?.address || "unknown"),
    userAgent: String(socket?.handshake?.headers?.["user-agent"] || ""),
  };

  socket.emit("cameras:list", getCameraList());

  socket.on("camera:register", (payload = {}) => {
    try {
      const cameraId = String(payload.cameraId || "").trim();
      const cameraLabel = String(payload.cameraLabel || "").trim();

      if (!cameraId || !cameraLabel) {
        return;
      }

      const camera = {
        cameraId,
        cameraLabel,
        source: String(payload.source || "unknown"),
        timestamp: new Date().toISOString(),
        socketId: socket.id,
      };

      activeCameras.set(cameraId, camera);

      if (!camerasBySocket.has(socket.id)) {
        camerasBySocket.set(socket.id, new Set());
      }
      camerasBySocket.get(socket.id).add(cameraId);

      runtimeStats.recordCameraConnected(cameraId);
      logger.info({
        service: "camera",
        event: "camera.connected",
        cameraId,
        message: `Camera connected: ${cameraLabel}`,
      });

      broadcastCameraList();
    } catch (error) {
      logger.error({
        service: "camera",
        event: "camera.register_error",
        message: "Failed to register camera",
        error,
      });
    }
  });

  socket.on("camera:disconnect", (payload = {}) => {
    try {
      const cameraId = String(payload.cameraId || "").trim();
      const removed = removeCamera(cameraId, socket.id);
      if (removed) {
        runtimeStats.recordCameraDisconnected(cameraId);
        logger.warn({
          service: "camera",
          event: "camera.disconnected",
          cameraId,
          message: "Camera disconnected",
        });
        broadcastCameraList();
      }
    } catch (error) {
      logger.error({
        service: "camera",
        event: "camera.disconnect_error",
        message: "Failed to process camera disconnect",
        error,
      });
    }
  });

  socket.on("student:register", (payload = {}) => {
    try {
      const student = studentStore.registerStudent(payload);
      io.emit("student:update", student);
      logger.info({
        service: "api",
        event: "face.registered",
        message: `Student face registered via socket: ${student.studentId}`,
      });
    } catch (error) {
      logger.error({
        service: "api",
        event: "student.register_socket_error",
        message: "Socket student registration failed",
        error,
      });
      socket.emit("student:register:error", { message: error.message });
    }
  });

  socket.on("face:detected", async (payload = {}) => {
    try {
      const studentId = String(payload.studentId || "").trim();
      if (!studentId) {
        return;
      }

      if (!security.isRoleAllowed(socketActor.role, ["operator", "admin"])) {
        logger.warn({
          service: "api",
          event: "socket.face_detected_forbidden",
          message: "Socket face detection rejected by role policy",
          details: {
            role: socketActor.role,
          },
        });

        auditLog.recordAudit({
          action: "socket.face_detected",
          status: "rejected",
          actor: socketActor,
          request: socketRequestMeta,
          target: {
            type: "student",
            id: studentId,
          },
          details: {
            reason: "role_forbidden",
            requiredRoles: ["operator", "admin"],
            socketId: socket.id,
          },
        });

        socket.emit("face:detected:error", {
          message: "Forbidden",
          reason: "role_forbidden",
        });
        return;
      }

      const unsignedPayload = { ...payload };
      delete unsignedPayload.signature;
      delete unsignedPayload.signatureTs;
      delete unsignedPayload.signature_ts;

      const signatureCheck = security.verifySignedPayload({
        payload: unsignedPayload,
        signature: payload.signature,
        signatureTs: payload.signatureTs || payload.signature_ts,
        scope: "socket.face:detected",
        required: security.REQUIRE_SIGNED_SOCKET_DETECTIONS,
      });

      if (!signatureCheck.valid) {
        logger.warn({
          service: "api",
          event: "socket.face_detected_signature_rejected",
          cameraId: String(payload.cameraId || "unknown-camera"),
          message: `Socket face detection signature rejected: ${signatureCheck.reason}`,
        });

        auditLog.recordAudit({
          action: "socket.face_detected",
          status: "rejected",
          actor: socketActor,
          request: socketRequestMeta,
          target: {
            type: "student",
            id: studentId,
          },
          signature: signatureCheck,
          details: {
            reason: signatureCheck.reason,
            socketId: socket.id,
          },
        });

        socket.emit("face:detected:error", {
          message: "Invalid detection signature",
          reason: signatureCheck.reason,
        });
        return;
      }

      const updated = applyFaceDetection({
        studentId,
        studentName: payload.studentName,
        cameraId: payload.cameraId,
        cameraLabel: payload.cameraLabel,
        confidence: payload.confidence,
        timestamp: payload.timestamp,
      });

      if (!updated) {
        return;
      }

      const timestamp = parseEventTimestamp(payload.timestamp).toISOString();
      const confidence = clampConfidence(payload.confidence);
      const cameraId = String(payload.cameraId || "unknown-camera");
      const cameraLabel = resolveCameraLabel(cameraId, payload.cameraLabel);

      runtimeAlerts.evaluateDetectionWarnings({
        cameraId,
        totalLatencyMs: Number(payload.latencyMs),
        confidence,
      });

      io.emit("student:update", updated);
      io.emit("detection:event", {
        studentId: updated.studentId,
        studentName: payload.studentName || updated.name,
        cameraId,
        cameraLabel,
        confidence,
        timestamp,
        method: "FACE-API",
      });

      logger.info({
        service: "recognition",
        event: "face.detected",
        cameraId,
        confidence,
        latencyMs: Number(payload.latencyMs) || null,
        message: `Face detected for student ${updated.studentId}`,
      });

      auditLog.recordAudit({
        action: "socket.face_detected",
        status: "success",
        actor: socketActor,
        request: socketRequestMeta,
        target: {
          type: "student",
          id: updated.studentId,
        },
        signature: signatureCheck,
        details: {
          cameraId,
          cameraLabel,
          confidence,
          socketId: socket.id,
        },
      });
    } catch (error) {
      logger.error({
        service: "api",
        event: "socket.face_detected_error",
        cameraId: String(payload?.cameraId || "unknown-camera"),
        message: "Socket face detection handler failed",
        error,
      });

      socket.emit("face:detected:error", {
        message: "Face detection failed",
      });
    }
  });

  socket.on("disconnect", () => {
    const owned = camerasBySocket.get(socket.id);
    if (owned && owned.size > 0) {
      Array.from(owned).forEach((cameraId) => {
        removeCamera(cameraId, socket.id);
        runtimeStats.recordCameraDisconnected(cameraId);
      });
      broadcastCameraList();
    }

    logger.info({
      service: "api",
      event: "socket.disconnected",
      message: `Socket disconnected: ${socket.id}`,
    });
  });
});

async function start() {
  studentStore.initializeStore();
  startAlertMonitor();
  runAlertChecks();

  const preferredPort = Number(process.env.PORT) || 5000;
  const activePort = await startServerWithPortFallback(preferredPort);
  const storeInfo = studentStore.getStoreInfo();
  logger.info({
    service: "api",
    event: "server.started",
    message: `Omni-Campus backend running on port ${activePort} (${storeInfo.mode} mode)`,
    details: {
      port: activePort,
      mode: storeInfo.mode,
      debug: logger.isDebugEnabled(),
    },
  });
}

async function startServerWithPortFallback(initialPort) {
  let port = initialPort;

  while (port <= 65535) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };

        const onListening = () => {
          server.off("error", onError);
          resolve();
        };

        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port);
      });

      return port;
    } catch (error) {
      if (error && error.code === "EADDRINUSE") {
        logger.warn({
          service: "api",
          event: "server.port_in_use",
          message: `Port ${port} in use, trying ${port + 1}`,
          details: {
            port,
            nextPort: port + 1,
          },
        });
        port += 1;
        continue;
      }

      throw error;
    }
  }

  throw new Error("No available port found");
}

async function gracefulShutdown() {
  try {
    if (alertCheckTimer) {
      clearInterval(alertCheckTimer);
      alertCheckTimer = null;
    }

    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
  } catch (error) {
    logger.error({
      service: "api",
      event: "server.shutdown_error",
      message: "Shutdown error",
      error,
    });
  } finally {
    logger.info({
      service: "api",
      event: "server.shutdown_complete",
      message: "Backend shutdown complete",
    });

    process.exit(0);
  }
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
process.on("uncaughtException", (error) => {
  logger.error({
    service: "api",
    event: "process.uncaught_exception",
    message: "Uncaught exception captured",
    error,
  });

  runtimeAlerts.createAlert({
    type: "process_uncaught_exception",
    message: `Uncaught exception: ${error.message}`,
    dedupeKey: "process_uncaught_exception",
  });
});

process.on("unhandledRejection", (reason) => {
  logger.error({
    service: "api",
    event: "process.unhandled_rejection",
    message: "Unhandled promise rejection captured",
    details: {
      reason: reason instanceof Error ? reason.message : String(reason || "unknown"),
    },
    error: reason instanceof Error ? reason : undefined,
  });

  runtimeAlerts.createAlert({
    type: "process_unhandled_rejection",
    message: `Unhandled rejection: ${
      reason instanceof Error ? reason.message : String(reason || "unknown")
    }`,
    dedupeKey: "process_unhandled_rejection",
  });
});

start().catch((error) => {
  logger.error({
    service: "api",
    event: "server.startup_failed",
    message: "Startup failed",
    error,
  });
  process.exit(1);
});
