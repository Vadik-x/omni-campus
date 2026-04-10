const express = require("express");
const recognition = require("../services/recognition");
const recognitionPipeline = require("../services/recognitionPipeline");
const cameraThresholds = require("../services/cameraThresholds");
const security = require("../services/security");
const auditLog = require("../services/auditLog");
const logger = require("../services/logger");

function toIsoTime(value) {
  const parsed = value ? new Date(value) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

module.exports = function recognitionRouter(io) {
  const router = express.Router();

  router.use((req, res, next) => {
    req.securityActor = security.resolveActorFromRequest(req);
    next();
  });

  router.get("/health", (req, res) => {
    try {
      return res.json({
        ...recognition.getHealthSummary(),
        ...recognitionPipeline.getPipelineHealthSummary(),
        cameraProfiles: cameraThresholds.getProfilesSummary(),
        security: security.getSecuritySummary(),
        audit: auditLog.getAuditSummary(),
      });
    } catch (error) {
      logger.error({
        service: "api",
        event: "recognition.health_error",
        message: "Failed to build recognition health response",
        error,
      });

      return res.status(500).json({ message: "Failed to get recognition health" });
    }
  });

  router.get("/metrics", (req, res) => {
    try {
      return res.json({
        ...recognition.getMetricsSnapshot(),
        ...recognitionPipeline.getPipelineMetricsSnapshot(),
      });
    } catch (error) {
      logger.error({
        service: "api",
        event: "recognition.metrics_error",
        message: "Failed to build recognition metrics response",
        error,
      });

      return res.status(500).json({ message: "Failed to get recognition metrics" });
    }
  });

  router.get(
    "/audit-logs",
    security.requireRole(["admin"], "recognition.audit.read"),
    (req, res) => {
      try {
        const limit = Number(req.query?.limit || 200);
        const action = String(req.query?.action || "");
        const status = String(req.query?.status || "");

        return res.json({
          items: auditLog.listAuditLogs({
            limit,
            action,
            status,
          }),
          inMemory: auditLog.listRecentInMemoryAuditLogs(50),
        });
      } catch (error) {
        logger.error({
          service: "api",
          event: "recognition.audit_read_error",
          message: "Failed to load audit logs",
          error,
        });

        return res.status(500).json({ message: "Failed to read audit logs" });
      }
    }
  );

  router.post(
    "/reindex",
    security.requireRole(["admin"], "recognition.reindex"),
    (req, res) => {
      try {
        const snapshot = recognition.reindex();

        auditLog.recordRequestAudit(req, {
          action: "recognition.reindex",
          status: "success",
          target: {
            type: "recognition-index",
            id: "global",
          },
          details: {
            indexedTemplates: snapshot.indexedTemplates,
            indexedStudents: snapshot.indexedStudents,
            durationMs: snapshot.durationMs,
          },
        });

        return res.json(snapshot);
      } catch (error) {
        auditLog.recordRequestAudit(req, {
          action: "recognition.reindex",
          status: "error",
          target: {
            type: "recognition-index",
            id: "global",
          },
          details: {
            message: error.message,
          },
        });

        return res.status(400).json({ message: error.message });
      }
    }
  );

  router.get("/camera-profiles", (req, res) => {
    try {
      return res.json(cameraThresholds.getProfilesSummary());
    } catch (error) {
      logger.error({
        service: "api",
        event: "recognition.camera_profiles_error",
        message: "Failed to load camera profiles",
        error,
      });

      return res.status(500).json({ message: "Failed to load camera profiles" });
    }
  });

  router.put(
    "/camera-profiles/:cameraId",
    security.requireRole(["admin"], "recognition.cameraProfile.update"),
    (req, res) => {
      try {
        const cameraId = String(req.params.cameraId || "").trim();
        const profile = cameraThresholds.upsertProfile(cameraId, req.body || {});

        auditLog.recordRequestAudit(req, {
          action: "recognition.cameraProfile.update",
          status: "success",
          target: {
            type: "camera-profile",
            id: cameraId,
          },
          details: {
            highRisk: profile.highRisk,
            thresholdDistance: profile.thresholdDistance,
            livenessMinScore: profile.livenessMinScore,
          },
        });

        return res.json({
          profile,
          summary: cameraThresholds.getProfilesSummary(),
        });
      } catch (error) {
        auditLog.recordRequestAudit(req, {
          action: "recognition.cameraProfile.update",
          status: "error",
          target: {
            type: "camera-profile",
            id: String(req.params.cameraId || "").trim(),
          },
          details: {
            message: error.message,
          },
        });

        return res.status(400).json({ message: error.message });
      }
    }
  );

  router.post(
    "/enroll",
    security.requireRole(["operator", "admin"], "recognition.enroll"),
    (req, res) => {
      try {
        const result = recognition.enrollStudent(req.body || {});
        io.emit("student:update", result.student);

        auditLog.recordRequestAudit(req, {
          action: "recognition.enroll",
          status: "success",
          target: {
            type: "student",
            id: String(result?.student?.studentId || ""),
          },
          details: {
            descriptorCount: result.descriptorCount,
            qualityAccepted: result?.quality?.accepted,
            qualityScore: result?.quality?.score,
            durationMs: result.durationMs,
          },
        });

        return res.status(201).json(result);
      } catch (error) {
        auditLog.recordRequestAudit(req, {
          action: "recognition.enroll",
          status: "error",
          target: {
            type: "student",
            id: String(req.body?.studentId || ""),
          },
          details: {
            message: error.message,
          },
        });

        return res.status(400).json({ message: error.message });
      }
    }
  );

  router.post("/match", (req, res) => {
    try {
      const {
        descriptor,
        cameraId,
        cameraLabel,
        thresholdDistance,
        topK,
        timestamp,
        trackHint,
        box,
        detectDurationMs,
        ingestToDetectMs,
        liveness,
      } = req.body || {};

      const signatureCheck = security.verifyRequestSignature(req, {
        payload: req.body || {},
        scope: "recognition.match",
      });

      if (!signatureCheck.valid) {
        logger.warn({
          service: "api",
          event: "recognition.match_signature_rejected",
          cameraId: String(cameraId || "unknown-camera"),
          message: `Recognition match rejected due to signature: ${signatureCheck.reason}`,
        });

        auditLog.recordRequestAudit(req, {
          action: "recognition.match",
          status: "rejected",
          target: {
            type: "camera",
            id: String(cameraId || "unknown-camera"),
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

      const resultPromise = recognitionPipeline.enqueueMatch(
        {
          descriptor,
          cameraId: String(cameraId || "unknown-camera"),
          cameraLabel: String(cameraLabel || "Unknown Camera"),
          thresholdDistance,
          topK,
          timestamp: toIsoTime(timestamp),
          trackHint,
          box,
          detectDurationMs: toNumber(detectDurationMs),
          ingestToDetectMs: toNumber(ingestToDetectMs),
          liveness,
        },
        io
      );

      return resultPromise
        .then((result) => {
          auditLog.recordRequestAudit(req, {
            action: "recognition.match",
            status: "success",
            target: {
              type: "camera",
              id: String(cameraId || "unknown-camera"),
            },
            signature: signatureCheck,
            details: {
              matched: result?.matched,
              eventEmitted: result?.eventEmitted,
              decision: result?.pipeline?.decision,
              liveness: result?.pipeline?.liveness,
              durationMs: result?.durationMs,
            },
          });

          return res.json(result);
        })
        .catch((error) => {
          auditLog.recordRequestAudit(req, {
            action: "recognition.match",
            status: "error",
            target: {
              type: "camera",
              id: String(cameraId || "unknown-camera"),
            },
            signature: signatureCheck,
            details: {
              message: error.message,
            },
          });

          logger.error({
            service: "api",
            event: "recognition.match_error",
            cameraId: String(cameraId || "unknown-camera"),
            message: "Recognition match request failed",
            error,
          });

          return res.status(400).json({ message: error.message });
        });
    } catch (error) {
      auditLog.recordRequestAudit(req, {
        action: "recognition.match",
        status: "error",
        target: {
          type: "camera",
          id: String(req.body?.cameraId || "unknown-camera"),
        },
        details: {
          message: error.message,
        },
      });

      logger.error({
        service: "api",
        event: "recognition.match_unhandled_error",
        cameraId: String(req.body?.cameraId || "unknown-camera"),
        message: "Unhandled recognition match route error",
        error,
      });

      return res.status(400).json({ message: error.message });
    }
  });

  router.post(
    "/match/direct",
    security.requireRole(["operator", "admin"], "recognition.match.direct"),
    (req, res) => {
      try {
        const { descriptor, thresholdDistance, topK } = req.body || {};

        const result = recognition.matchDescriptor({
          descriptor,
          thresholdDistance,
          topK,
        });

        return res.json({
          ...result,
          eventEmitted: false,
        });
      } catch (error) {
        logger.error({
          service: "api",
          event: "recognition.match_direct_error",
          message: "Direct recognition match failed",
          error,
        });

        return res.status(400).json({ message: error.message });
      }
    }
  );

  return router;
};
