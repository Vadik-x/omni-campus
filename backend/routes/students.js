const express = require("express");
const studentStore = require("../services/studentStore");
const security = require("../services/security");
const auditLog = require("../services/auditLog");
const logger = require("../services/logger");

module.exports = function studentsRouter(io) {
  const router = express.Router();

  router.use((req, res, next) => {
    req.securityActor = security.resolveActorFromRequest(req);
    next();
  });

  router.get("/", (req, res) => {
    try {
      return res.json(studentStore.listStudents(req.query));
    } catch (error) {
      logger.error({
        service: "api",
        event: "students.list_error",
        message: "Failed to list students",
        error,
      });

      return res.status(500).json({ message: "Failed to list students" });
    }
  });

  router.get("/export", (req, res) => {
    try {
      return res.json(studentStore.exportStudents());
    } catch (error) {
      logger.error({
        service: "api",
        event: "students.export_error",
        message: "Failed to export students",
        error,
      });

      return res.status(500).json({ message: "Failed to export students" });
    }
  });

  router.post("/", security.requireRole(["operator", "admin"], "students.upsert"), (req, res) => {
    try {
      const beforeCount = studentStore.countStudents();

      const student = studentStore.registerStudent(req.body || {});
      io.emit("student:update", student);

      const afterCount = studentStore.countStudents();
      const created = afterCount > beforeCount;

      auditLog.recordRequestAudit(req, {
        action: "students.upsert",
        status: "success",
        target: {
          type: "student",
          id: String(student?.studentId || ""),
        },
        details: {
          created,
        },
      });

      logger.info({
        service: "api",
        event: created ? "face.registered" : "face.updated",
        message: created
          ? `Face registered for student ${student.studentId}`
          : `Face record updated for student ${student.studentId}`,
        details: {
          studentId: student.studentId,
          created,
          actorRole: req?.securityActor?.role || "viewer",
        },
      });

      return res.status(created ? 201 : 200).json(student);
    } catch (error) {
      auditLog.recordRequestAudit(req, {
        action: "students.upsert",
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
        event: "students.upsert_error",
        message: "Student upsert failed",
        error,
      });

      return res.status(400).json({ message: error.message });
    }
  });

  router.post("/import", security.requireRole(["admin"], "students.import"), (req, res) => {
    try {
      const payload = Array.isArray(req.body) ? req.body : [];
      const previousStudents = studentStore.exportStudents();
      const importedStudents = studentStore.importStudents(payload);

      previousStudents.forEach((student) => {
        const studentId = String(student?.studentId || "").trim();
        if (!studentId) {
          return;
        }

        io.emit("student:removed", { studentId });
        io.emit("student:delete", { studentId });
      });

      io.emit("students:cleared", { count: previousStudents.length });
      importedStudents.forEach((student) => {
        io.emit("student:update", student);
      });

      auditLog.recordRequestAudit(req, {
        action: "students.import",
        status: "success",
        target: {
          type: "student-set",
          id: "all",
        },
        details: {
          previousCount: previousStudents.length,
          importedCount: importedStudents.length,
        },
      });

      logger.info({
        service: "api",
        event: "admin.students_import",
        message: `Admin import completed (${importedStudents.length} students)` ,
        details: {
          importedCount: importedStudents.length,
          previousCount: previousStudents.length,
          actorRole: req?.securityActor?.role || "viewer",
        },
      });

      return res.json({
        count: importedStudents.length,
        students: importedStudents,
      });
    } catch (error) {
      auditLog.recordRequestAudit(req, {
        action: "students.import",
        status: "error",
        target: {
          type: "student-set",
          id: "all",
        },
        details: {
          message: error.message,
        },
      });

      logger.error({
        service: "api",
        event: "students.import_error",
        message: "Student import failed",
        error,
      });

      return res.status(400).json({ message: error.message });
    }
  });

  router.delete("/", security.requireRole(["admin"], "students.deleteAll"), (req, res) => {
    try {
      const removedStudents = studentStore.clearStudents();

      removedStudents.forEach((student) => {
        const studentId = String(student?.studentId || "").trim();
        if (!studentId) {
          return;
        }

        io.emit("student:removed", { studentId });
        io.emit("student:delete", { studentId });
      });

      io.emit("students:cleared", { count: removedStudents.length });

      auditLog.recordRequestAudit(req, {
        action: "students.deleteAll",
        status: "success",
        target: {
          type: "student-set",
          id: "all",
        },
        details: {
          removedCount: removedStudents.length,
        },
      });

      logger.info({
        service: "api",
        event: "admin.students_delete_all",
        message: `Admin removed all students (${removedStudents.length})`,
        details: {
          removedCount: removedStudents.length,
          actorRole: req?.securityActor?.role || "viewer",
        },
      });

      return res.json({
        success: true,
        removedCount: removedStudents.length,
      });
    } catch (error) {
      logger.error({
        service: "api",
        event: "students.delete_all_error",
        message: "Delete all students failed",
        error,
      });

      return res.status(500).json({ message: "Failed to clear students" });
    }
  });

  router.get("/:id", (req, res) => {
    try {
      const student = studentStore.getStudent(req.params.id);
      if (!student) {
        return res.status(404).json({ message: "Student not found" });
      }

      return res.json(student);
    } catch (error) {
      logger.error({
        service: "api",
        event: "students.get_error",
        message: "Failed to load student by id",
        error,
      });

      return res.status(500).json({ message: "Failed to load student" });
    }
  });

  router.patch("/:id", security.requireRole(["operator", "admin"], "students.update"), (req, res) => {
    try {
      const updated = studentStore.updateStudent(req.params.id, req.body || {});
      if (!updated) {
        auditLog.recordRequestAudit(req, {
          action: "students.update",
          status: "error",
          target: {
            type: "student",
            id: String(req.params.id || ""),
          },
          details: {
            message: "Student not found",
          },
        });

        return res.status(404).json({ message: "Student not found" });
      }

      io.emit("student:update", updated);

      auditLog.recordRequestAudit(req, {
        action: "students.update",
        status: "success",
        target: {
          type: "student",
          id: String(updated.studentId || req.params.id || ""),
        },
      });

      return res.json(updated);
    } catch (error) {
      logger.error({
        service: "api",
        event: "students.update_error",
        message: "Student update failed",
        error,
      });

      return res.status(500).json({ message: "Failed to update student" });
    }
  });

  router.delete("/:id", security.requireRole(["admin"], "students.delete"), (req, res) => {
    try {
      const { id } = req.params;
      const removed = studentStore.remove(id);
      if (!removed) {
        auditLog.recordRequestAudit(req, {
          action: "students.delete",
          status: "error",
          target: {
            type: "student",
            id: String(id || ""),
          },
          details: {
            message: "Student not found",
          },
        });

        return res.status(404).json({ error: "Student not found" });
      }

      const studentId = String(removed.studentId || id).trim();

      io.emit("student:removed", {
        studentId,
      });

      io.emit("student:delete", {
        studentId,
      });

      auditLog.recordRequestAudit(req, {
        action: "students.delete",
        status: "success",
        target: {
          type: "student",
          id: studentId,
        },
      });

      logger.info({
        service: "api",
        event: "face.deleted",
        message: `Face deleted for student ${studentId}`,
        details: {
          studentId,
          actorRole: req?.securityActor?.role || "viewer",
        },
      });

      return res.json({ success: true, student: removed });
    } catch (error) {
      logger.error({
        service: "api",
        event: "students.delete_error",
        message: "Student delete failed",
        error,
      });

      return res.status(500).json({ message: "Failed to delete student" });
    }
  });

  router.patch(
    "/:id/location",
    security.requireRole(["operator", "admin"], "students.location.update"),
    (req, res) => {
      try {
        const { buildingId, buildingName, detectedBy, timestamp, status } = req.body || {};

        if (!buildingId || !buildingName || !detectedBy) {
          return res.status(400).json({
            message:
              "buildingId, buildingName and detectedBy are required for location update",
          });
        }

        const student = studentStore.updateLocation(req.params.id, {
          buildingId,
          buildingName,
          detectedBy,
          timestamp,
          status: status || "online",
        });

        if (!student) {
          return res.status(404).json({ message: "Student not found" });
        }

        io.emit("student:update", student);

        auditLog.recordRequestAudit(req, {
          action: "students.location.update",
          status: "success",
          target: {
            type: "student",
            id: String(student.studentId || req.params.id || ""),
          },
          details: {
            buildingId,
            buildingName,
          },
        });

        return res.json(student);
      } catch (error) {
        logger.error({
          service: "api",
          event: "students.location_update_error",
          message: "Student location update failed",
          error,
        });

        return res.status(500).json({ message: "Failed to update location" });
      }
    }
  );

  return router;
};
