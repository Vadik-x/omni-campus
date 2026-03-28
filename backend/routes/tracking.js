const express = require("express");
const { parseCameraPayload } = require("../services/camera");
const { mergeSignals } = require("../services/fusion");
const studentStore = require("../services/studentStore");

module.exports = function trackingRouter(io) {
  const router = express.Router();

  router.post("/detection", async (req, res, next) => {
    try {
      const { studentId, camera, wifi, rfid } = req.body;
      if (!studentId) {
        return res.status(400).json({ message: "studentId is required" });
      }

      const parsedCamera = camera ? parseCameraPayload(camera) : null;
      const merged = mergeSignals({ camera: parsedCamera, wifi, rfid });

      if (!merged?.buildingId || !merged?.buildingName || !merged?.detectedBy) {
        return res.status(400).json({
          message:
            "Merged signal missing required buildingId, buildingName or detectedBy",
        });
      }

      const eventTime = merged.timestamp ? new Date(merged.timestamp) : new Date();

      const updated = studentStore.updateLocation(studentId, {
        buildingId: merged.buildingId,
        buildingName: merged.buildingName,
        detectedBy: merged.detectedBy,
        timestamp: eventTime,
        status: "online",
      });

      if (!updated) {
        return res.status(404).json({ message: "Student not found" });
      }

      io.emit("student:update", updated);
      io.emit("detection:event", {
        studentId: updated.studentId,
        studentName: updated.name,
        cameraId: merged.buildingId,
        cameraLabel: merged.buildingName,
        location: updated.currentLocation?.buildingName || merged.buildingName,
        method: merged.detectedBy,
        timestamp: eventTime,
        confidence: 0.8,
      });
      return res.json({ message: "Detection recorded", student: updated });
    } catch (error) {
      return next(error);
    }
  });

  router.post("/simulate", async (req, res, next) => {
    try {
      const { studentId, buildingName } = req.body || {};
      if (!studentId) {
        return res.status(400).json({ message: "studentId is required" });
      }

      const location = buildingName || process.env.CAMERA_ZONE || "Library - Block B";
      const buildingId = location
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

      const updated = studentStore.updateLocation(studentId, {
        buildingId,
        buildingName: location,
        detectedBy: "CAMERA",
        timestamp: new Date(),
        status: "online",
      });
      if (!updated) {
        return res.status(404).json({ message: "Student not found" });
      }

      io.emit("student:update", updated);
      io.emit("detection:event", {
        studentId: updated.studentId,
        studentName: updated.name,
        cameraId: buildingId,
        cameraLabel: updated.currentLocation?.buildingName,
        location: updated.currentLocation?.buildingName,
        method: updated.currentLocation?.detectedBy || "CAMERA",
        timestamp: updated.currentLocation?.lastSeen || new Date(),
        confidence: 1,
      });

      return res.json({ message: "Simulation recorded", student: updated });
    } catch (error) {
      return next(error);
    }
  });

  return router;
};
