const PLACEHOLDER_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxAQEBAQDxAQEA8QEA8QDw8QDw8QEA8QFREWFhURFRUYHSggGBolGxUVITEhJSkrLi4uFx8zODMsNygtLisBCgoKDg0OGxAQGy0mICYtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAEAAgMBIgACEQEDEQH/xAAXAAEBAQEAAAAAAAAAAAAAAAAAAQID/8QAFhEBAQEAAAAAAAAAAAAAAAAAABEh/8QAFQEBAQAAAAAAAAAAAAAAAAAABQP/xAAVEQEBAAAAAAAAAAAAAAAAAAABAP/aAAwDAQACEQMRAD8AmAClQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH/2Q==";
const MOCK_CAMERA_ACTIVE_SVG_BASE64 = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#031321"/><stop offset="1" stop-color="#0e2f44"/></linearGradient></defs><rect width="640" height="360" fill="url(#g)"/><rect x="40" y="40" width="560" height="280" rx="18" fill="#091f31" stroke="#00d4ff" stroke-width="2"/><circle cx="210" cy="180" r="36" fill="#00d4ff" opacity="0.3"/><circle cx="210" cy="180" r="17" fill="#00d4ff"/><text x="260" y="175" font-size="34" font-family="Segoe UI, Arial" fill="#e8f7ff" font-weight="700">Camera Active</text><text x="260" y="206" font-size="18" font-family="Segoe UI, Arial" fill="#9cc6da">Mock preview fallback is running</text></svg>`
).toString("base64");

let NodeWebcam = null;
try {
  NodeWebcam = require("node-webcam");
} catch (error) {
  NodeWebcam = null;
}

let StreamCtor = null;
try {
  StreamCtor = require("node-rtsp-stream");
} catch (error) {
  StreamCtor = null;
}

let latestFrame = PLACEHOLDER_JPEG_BASE64;
let connected = false;
let mode = "mock";
let activeUrl = process.env.CAMERA_URL || "";
let rtspStream = null;
let frameTimer = null;
let liveConnectionLogged = false;
const LIVE_FRAME_INTERVAL_MS = Number(process.env.CAMERA_FRAME_INTERVAL_MS || 180);
const MOCK_FRAME_INTERVAL_MS = Number(process.env.MOCK_FRAME_INTERVAL_MS || 600);

function toMockMode() {
  connected = false;
  mode = "mock";
  liveConnectionLogged = false;
  console.log("Camera disconnected - using mock mode");
}

function emitCameraFrame(io) {
  if (!io) {
    return;
  }

  io.emit("camera-frame", {
    frame: getDisplayFrame(),
    connected,
    mode,
    timestamp: new Date().toISOString(),
  });
}

function startMockEmitter(io) {
  if (frameTimer) {
    clearInterval(frameTimer);
  }

  frameTimer = setInterval(() => {
    emitCameraFrame(io);
  }, MOCK_FRAME_INTERVAL_MS);
}

function startCameraStream(io) {
  activeUrl = process.env.CAMERA_URL || "";

  if (frameTimer) {
    clearInterval(frameTimer);
    frameTimer = null;
  }

  const webcamRequested = !activeUrl || activeUrl === "0" || activeUrl.toLowerCase() === "webcam";

  if (webcamRequested && NodeWebcam) {
    const webcam = NodeWebcam.create({
      width: 480,
      height: 270,
      quality: 45,
      saveShots: false,
      output: "jpeg",
      callbackReturn: "base64",
      device: false,
      verbose: false,
    });

    const captureFromWebcam = () => {
      webcam.capture("omni-campus-frame", (error, data) => {
        if (error || !data) {
          if (mode !== "mock") {
            toMockMode();
          }
          emitCameraFrame(io);
          return;
        }

        const normalized = normalizeBase64(data);
        if (normalized) {
          latestFrame = normalized;
          connected = true;
          mode = "live";
          if (!liveConnectionLogged) {
            console.log("Camera connected");
            liveConnectionLogged = true;
          }
        }

        emitCameraFrame(io);
      });
    };

    captureFromWebcam();
    frameTimer = setInterval(captureFromWebcam, LIVE_FRAME_INTERVAL_MS);
    return;
  }

  if (!activeUrl || !StreamCtor) {
    toMockMode();
    startMockEmitter(io);
    return;
  }

  try {
    rtspStream = new StreamCtor({
      name: "omni-campus-camera",
      streamUrl: activeUrl,
      wsPort: 9999,
      ffmpegOptions: {
        "-stats": "",
        "-r": 30,
      },
    });

    connected = true;
    mode = "live";
    if (!liveConnectionLogged) {
      console.log("Camera connected");
      liveConnectionLogged = true;
    }

    startMockEmitter(io);

    if (rtspStream && rtspStream.mpeg1Muxer) {
      rtspStream.mpeg1Muxer.on("exitWithError", () => {
        toMockMode();
      });

      rtspStream.mpeg1Muxer.on("error", () => {
        toMockMode();
      });
    }
  } catch (error) {
    toMockMode();
    startMockEmitter(io);
  }
}

function normalizeBase64(frame) {
  if (!frame || typeof frame !== "string") {
    return null;
  }

  const match = frame.match(/^data:image\/(?:jpeg|jpg|png);base64,(.+)$/i);
  return match ? match[1] : frame;
}

function saveLatestFrame(frame) {
  const cleaned = normalizeBase64(frame);
  if (!cleaned) {
    return false;
  }

  latestFrame = cleaned;
  connected = true;
  mode = "live";
  return true;
}

function captureFrame() {
  return latestFrame || PLACEHOLDER_JPEG_BASE64;
}

function getCameraStatus() {
  return {
    connected,
    url: activeUrl,
    mode,
  };
}

function getDisplayFrame() {
  if (mode === "mock") {
    return `data:image/svg+xml;base64,${MOCK_CAMERA_ACTIVE_SVG_BASE64}`;
  }

  return `data:image/jpeg;base64,${captureFrame()}`;
}

function parseCameraPayload(payload) {
  return {
    buildingId: payload?.buildingId,
    buildingName: payload?.buildingName,
    detectedBy: "camera",
    timestamp: payload?.timestamp ? new Date(payload.timestamp) : new Date(),
  };
}

module.exports = {
  startCameraStream,
  saveLatestFrame,
  captureFrame,
  getDisplayFrame,
  emitCameraFrame,
  getCameraStatus,
  parseCameraPayload,
};
