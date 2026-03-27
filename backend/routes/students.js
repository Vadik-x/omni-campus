const express = require("express");
const mongoose = require("mongoose");
const Student = require("../models/Student");
const mockStore = require("../services/mockStore");

function buildSearchQuery({ q, name, studentId, program }) {
  const query = {};

  if (q) {
    query.$or = [
      { name: { $regex: q, $options: "i" } },
      { studentId: { $regex: q, $options: "i" } },
      { program: { $regex: q, $options: "i" } },
    ];
  }

  if (name) {
    query.name = { $regex: name, $options: "i" };
  }

  if (studentId) {
    query.studentId = { $regex: studentId, $options: "i" };
  }

  if (program) {
    query.program = { $regex: program, $options: "i" };
  }

  return query;
}

module.exports = function studentsRouter(io) {
  const router = express.Router();
  const useMock = () => mongoose.connection.readyState !== 1;

  router.get("/", async (req, res, next) => {
    try {
      const students = useMock()
        ? mockStore.listStudents(req.query)
        : await Student.find(buildSearchQuery(req.query)).sort({ name: 1 });
      return res.json(students);
    } catch (error) {
      return next(error);
    }
  });

  router.get("/:id", async (req, res, next) => {
    try {
      const student = useMock()
        ? mockStore.getStudent(req.params.id)
        : await Student.findOne({ studentId: req.params.id });
      if (!student) {
        return res.status(404).json({ message: "Student not found" });
      }

      return res.json(student);
    } catch (error) {
      return next(error);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const created = useMock()
        ? mockStore.createStudent(req.body)
        : await Student.create(req.body);
      return res.status(201).json(created);
    } catch (error) {
      if (error.code === 11000) {
        return res.status(409).json({ message: "studentId already exists" });
      }

      return next(error);
    }
  });

  router.patch("/:id/location", async (req, res, next) => {
    try {
      const { buildingId, buildingName, detectedBy, timestamp, status } = req.body;

      if (!buildingId || !buildingName || !detectedBy) {
        return res.status(400).json({
          message:
            "buildingId, buildingName and detectedBy are required for location update",
        });
      }

      const eventTime = timestamp ? new Date(timestamp) : new Date();
      const historyRecord = {
        buildingId,
        buildingName,
        detectedBy,
        timestamp: eventTime,
      };

      const student = useMock()
        ? mockStore.updateLocation(req.params.id, {
            ...historyRecord,
            status: status || "online",
          })
        : await Student.findOneAndUpdate(
            { studentId: req.params.id },
            {
              $set: {
                currentLocation: {
                  buildingId,
                  buildingName,
                  detectedBy,
                  lastSeen: eventTime,
                },
                isOnCampus: true,
                status: status || "online",
              },
              $push: {
                locationHistory: historyRecord,
              },
            },
            { new: true, runValidators: true }
          );

      if (!student) {
        return res.status(404).json({ message: "Student not found" });
      }

      io.emit("student:update", student);
      return res.json(student);
    } catch (error) {
      return next(error);
    }
  });

  return router;
};
