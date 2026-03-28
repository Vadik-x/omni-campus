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
    const removed = studentStore.deleteStudent(req.params.id);
    if (!removed) {
      return res.status(404).json({ message: "Student not found" });
    }

    return res.json({
      message: "Student deleted",
      student: removed,
    });
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
