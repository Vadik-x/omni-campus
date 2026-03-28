const express = require("express");
const studentStore = require("../services/studentStore");

module.exports = function studentsRouter(io) {
  const router = express.Router();

  router.get("/", (req, res) => {
    return res.json(studentStore.listStudents(req.query));
  });

  router.get("/export", (req, res) => {
    return res.json(studentStore.exportStudents());
  });

  router.post("/", (req, res) => {
    try {
      const requestedId = String(req.body?.studentId || "").trim();
      const existed = requestedId ? studentStore.getStudent(requestedId) : null;

      const student = studentStore.registerStudent(req.body || {});
      io.emit("student:update", student);

      return res.status(existed ? 200 : 201).json(student);
    } catch (error) {
      return res.status(400).json({ message: error.message });
    }
  });

  router.delete("/", (req, res) => {
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

    return res.json({
      success: true,
      removedCount: removedStudents.length,
    });
  });

  router.get("/:id", (req, res) => {
    const student = studentStore.getStudent(req.params.id);
    if (!student) {
      return res.status(404).json({ message: "Student not found" });
    }

    return res.json(student);
  });

  router.patch("/:id", (req, res) => {
    const updated = studentStore.updateStudent(req.params.id, req.body || {});
    if (!updated) {
      return res.status(404).json({ message: "Student not found" });
    }

    io.emit("student:update", updated);
    return res.json(updated);
  });

  router.delete("/:id", (req, res) => {
    const { id } = req.params;
    const removed = studentStore.remove(id);
    if (!removed) {
      return res.status(404).json({ error: "Student not found" });
    }

    const studentId = String(removed.studentId || id).trim();

    io.emit("student:removed", {
      studentId,
    });

    io.emit("student:delete", {
      studentId,
    });

    return res.json({ success: true });
  });

  router.patch("/:id/location", (req, res) => {
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
    return res.json(student);
  });

  return router;
};
