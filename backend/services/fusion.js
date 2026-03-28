const studentStore = require("./studentStore");

function mergeSignals({ camera, wifi, rfid }) {
  if (rfid) {
    return { ...rfid, detectedBy: "rfid" };
  }

  if (camera) {
    return { ...camera, detectedBy: "camera" };
  }

  if (wifi) {
    return { ...wifi, detectedBy: "wifi" };
  }

  return null;
}

function toBuildingId(buildingName) {
  return String(buildingName || "unknown-zone")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function startFusionLoop(io) {
  // Automatic fusion loop intentionally disabled.
  return io;
}

function stopFusionLoop() {
  // No-op. Interval-based loop has been removed.
}

async function simulateDetection(studentId, buildingName) {
  const student = studentStore.getStudent(studentId);
  if (!student) {
    return null;
  }

  const now = new Date();
  const location = buildingName || process.env.CAMERA_ZONE || "Library - Block B";
  const buildingId = toBuildingId(location);

  return studentStore.updateLocation(studentId, {
    buildingId,
    buildingName: location,
    detectedBy: "CAMERA",
    timestamp: now,
    status: "online",
  });
}

module.exports = {
  mergeSignals,
  startFusionLoop,
  stopFusionLoop,
  simulateDetection,
};
