require("dotenv").config();

const http = require("http");
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const { Server } = require("socket.io");

const createStudentsRouter = require("./routes/students");
const createTrackingRouter = require("./routes/tracking");
const createCameraRouter = require("./routes/camera");
const seedStudents = require("./services/seed-on-start");
const { startCameraStream } = require("./services/camera");
const { startFusionLoop, stopFusionLoop } = require("./services/fusion");
const { resetMockStore } = require("./services/mockStore");

const app = express();
const server = http.createServer(app);
const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";

const io = new Server(server, {
  cors: {
    origin: frontendUrl,
    methods: ["GET", "POST", "PATCH"],
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
    mode: mongoose.connection.readyState === 1 ? "database" : "mock",
  });
});

app.use("/api/students", createStudentsRouter(io));
app.use("/api/tracking", createTrackingRouter(io));
app.use("/api/camera", createCameraRouter(io));

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

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  socket.on("disconnect", () => {
    console.log("Socket disconnected:", socket.id);
  });
});

async function start() {
  const port = Number(process.env.PORT) || 5000;

  let dbConnected = false;
  if (process.env.MONGO_URI) {
    try {
      await mongoose.connect(process.env.MONGO_URI);
      await seedStudents();
      dbConnected = true;
      console.log("Database connected");
    } catch (error) {
      console.warn("Database unavailable. Starting in mock mode.");
      resetMockStore();
    }
  } else {
    console.warn("MONGO_URI missing. Starting in mock mode.");
    resetMockStore();
  }

  startCameraStream(io);
  startFusionLoop(io);

  server.listen(port, () => {
    console.log(`Omni-Campus backend running on port ${port} (${dbConnected ? "database" : "mock"} mode)`);
  });
}

async function gracefulShutdown() {
  try {
    stopFusionLoop();
    await mongoose.disconnect();
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
