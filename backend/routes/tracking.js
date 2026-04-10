const express = require("express");
const { parseCameraPayload } = require("../services/camera");
const { mergeSignals } = require("../services/fusion");
const studentStore = require("../services/studentStore");
const security = require("../services/security");
const auditLog = require("../services/auditLog");
const logger = require("../services/logger");
const runtimeMetrics = require("../services/runtimeMetrics");
const runtimeStats = require("../services/runtimeStats");

module.exports = function trackingRouter(io) {
  const router = express.Router();

  router.use((req, res, next) => {
    req.securityActor = security.resolveActorFromRequest(req);
    next();
  });

  router.post(
    "/detection",
    security.requireRole(["operator", "admin"], "tracking.detection"),
    async (req, res, next) => {
    try {
      const signatureCheck = security.verifyRequestSignature(req, {
        payload: req.body || {},
        scope: "tracking.detection",
      });

      if (!signatureCheck.valid) {
        logger.warn({
          service: "api",
          event: "tracking.detection_signature_rejected",
          cameraId: String(req.body?.camera?.buildingId || "unknown-camera"),
          message: `Tracking detection rejected due to signature: ${signatureCheck.reason}`,
        });

        auditLog.recordRequestAudit(req, {
          action: "tracking.detection",
          status: "rejected",
          target: {
            type: "student",
            id: String(req.body?.studentId || ""),
          },
          signature: signatureCheck,
          details: {
            reason: signatureCheck.reason,
          },
        });

        return res.status(401).json({
          message: "Invalid detection signature",
          reason: signatureCheck.reason,
        });
      }

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

      runtimeMetrics.recordMetricEvent({
        timestamp: eventTime.toISOString(),
        cameraId: merged.buildingId,
        ingest_to_detect_ms: null,
        detect_to_match_ms: null,
        total_latency_ms: null,
        match_confidence: 0.8,
        matched: true,
        source: "tracking",
      });

      runtimeStats.recordDetection({
        cameraId: merged.buildingId,
        matched: true,
        totalLatencyMs: null,
      });

      logger.info({
        service: "api",
        event: "tracking.detection_recorded",
        cameraId: merged.buildingId,
        confidence: 0.8,
        message: "Tracking detection recorded",
      });

      auditLog.recordRequestAudit(req, {
        action: "tracking.detection",
        status: "success",
        target: {
          type: "student",
          id: String(updated.studentId || studentId),
        },
        signature: signatureCheck,
        details: {
          buildingId: merged.buildingId,
          buildingName: merged.buildingName,
          detectedBy: merged.detectedBy,
        },
      });

      return res.json({ message: "Detection recorded", student: updated });
    } catch (error) {
      auditLog.recordRequestAudit(req, {
        action: "tracking.detection",
        status: "error",
        target: {
          type: "student",
          id: String(req.body?.studentId || ""),
        },
        details: {
          message: error.message,
        },
      });

      logger.error({
        service: "api",
        event: "tracking.detection_error",
        cameraId: String(req.body?.camera?.buildingId || "unknown-camera"),
        message: "Tracking detection route failed",
        error,
      });

      return next(error);
    }
    }
  );

  router.post(
    "/simulate",
    security.requireRole(["admin"], "tracking.simulate"),
    async (req, res, next) => {
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

      runtimeStats.recordDetection({
        cameraId: buildingId,
        matched: true,
        totalLatencyMs: null,
      });

      logger.info({
        service: "api",
        event: "tracking.simulate_recorded",
        cameraId: buildingId,
        confidence: 1,
        message: "Tracking simulation recorded",
      });

      auditLog.recordRequestAudit(req, {
        action: "tracking.simulate",
        status: "success",
        target: {
          type: "student",
          id: String(updated.studentId || studentId),
        },
        details: {
          buildingId,
          buildingName: location,
        },
      });

      return res.json({ message: "Simulation recorded", student: updated });
    } catch (error) {
      auditLog.recordRequestAudit(req, {
        action: "tracking.simulate",
        status: "error",
        target: {
          type: "student",
          id: String(req.body?.studentId || ""),
        },
        details: {
          message: error.message,
        },
      });

      logger.error({
        service: "api",
        event: "tracking.simulate_error",
        cameraId: String(req.body?.buildingId || "unknown-camera"),
        message: "Tracking simulate route failed",
        error,
      });

      return next(error);
    }
    }
  );

  return router;
};
