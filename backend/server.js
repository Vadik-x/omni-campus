require("dotenv").config();

const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");

const createStudentsRouter = require("./routes/students");
const createTrackingRouter = require("./routes/tracking");
const cameraRoutes = require("./routes/camera");
const studentStore = require("./services/studentStore");

const app = express();
const server = http.createServer(app);
const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
const activeCameras = new Map();
const camerasBySocket = new Map();

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

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    mode: "file-store",
    students: studentStore.countStudents(),
  });
});

app.use("/api/students", createStudentsRouter(io));
app.use("/api/tracking", createTrackingRouter(io));
app.use("/api/proxy", cameraRoutes);

app.use((req, res) => {
  res.status(404).json({ message: "Route not found" });
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

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

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  socket.emit("cameras:list", getCameraList());

  socket.on("camera:register", (payload = {}) => {
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

    broadcastCameraList();
  });

  socket.on("camera:disconnect", (payload = {}) => {
    const cameraId = String(payload.cameraId || "").trim();
    const removed = removeCamera(cameraId, socket.id);
    if (removed) {
      broadcastCameraList();
    }
  });

  socket.on("student:register", (payload = {}) => {
    try {
      const student = studentStore.registerStudent(payload);
      io.emit("student:update", student);
    } catch (error) {
      socket.emit("student:register:error", { message: error.message });
    }
  });

  socket.on("face:detected", async (payload = {}) => {
    const studentId = String(payload.studentId || "").trim();
    if (!studentId) {
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
  });

  socket.on("disconnect", () => {
    const owned = camerasBySocket.get(socket.id);
    if (owned && owned.size > 0) {
      Array.from(owned).forEach((cameraId) => {
        removeCamera(cameraId, socket.id);
      });
      broadcastCameraList();
    }

    console.log("Socket disconnected:", socket.id);
  });
});

async function start() {
  studentStore.initializeStore();

  const preferredPort = Number(process.env.PORT) || 5000;
  const activePort = await startServerWithPortFallback(preferredPort);
  console.log(`Omni-Campus backend running on port ${activePort} (file-store mode)`);
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
        console.warn(`Port ${port} in use, trying ${port + 1}...`);
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
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
  } catch (error) {
    console.error("Shutdown error:", error.message);
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

start().catch((error) => {
  console.error("Startup failed:", error.message);
  process.exit(1);
});
