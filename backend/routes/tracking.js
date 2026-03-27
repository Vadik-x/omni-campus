const express = require("express");
const mongoose = require("mongoose");
const Student = require("../models/Student");
const { parseCameraPayload } = require("../services/camera");
const { mergeSignals, simulateDetection } = require("../services/fusion");
const mockStore = require("../services/mockStore");

module.exports = function trackingRouter(io) {
  const router = express.Router();
  const useMock = () => mongoose.connection.readyState !== 1;

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

      const updated = useMock()
        ? mockStore.applyMergedDetection(studentId, {
            ...merged,
            timestamp: eventTime,
          })
        : await Student.findOneAndUpdate(
            { studentId },
            {
              $set: {
                currentLocation: {
                  buildingId: merged.buildingId,
                  buildingName: merged.buildingName,
                  detectedBy: merged.detectedBy,
                  lastSeen: eventTime,
                },
                isOnCampus: true,
                status: "online",
              },
              $push: {
                locationHistory: {
                  buildingId: merged.buildingId,
                  buildingName: merged.buildingName,
                  detectedBy: merged.detectedBy,
                  timestamp: eventTime,
                },
              },
            },
            { new: true, runValidators: true }
          );

      if (!updated) {
        return res.status(404).json({ message: "Student not found" });
      }

      io.emit("student:update", updated);
      io.emit("detection:event", {
        studentName: updated.name,
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

      const updated = useMock()
        ? mockStore.updateLocation(studentId, {
            buildingId: (buildingName || process.env.CAMERA_ZONE || "Library - Block B")
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-+|-+$/g, ""),
            buildingName: buildingName || process.env.CAMERA_ZONE || "Library - Block B",
            detectedBy: "CAMERA",
            timestamp: new Date(),
            status: "online",
          })
        : await simulateDetection(studentId, buildingName);
      if (!updated) {
        return res.status(404).json({ message: "Student not found" });
      }

      io.emit("student:update", updated);
      io.emit("detection:event", {
        studentName: updated.name,
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
