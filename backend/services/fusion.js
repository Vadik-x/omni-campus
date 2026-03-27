const mongoose = require("mongoose");
const Student = require("../models/Student");
const mockStore = require("./mockStore");
const { captureFrame } = require("./camera");
const { identifyStudent } = require("./gemini");

let fusionTimer = null;
let tickRunning = false;
let ioRef = null;

function useMockStore() {
  return mongoose.connection.readyState !== 1;
}

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

function emitUpdate(updatedStudent) {
  if (!ioRef || !updatedStudent) {
    return;
  }

  ioRef.emit("student:update", updatedStudent);
}

function emitDetectionEvent({ studentName, location, method, timestamp, confidence }) {
  if (!ioRef) {
    return;
  }

  ioRef.emit("detection:event", {
    studentName,
    location,
    method,
    timestamp,
    confidence,
  });
}

async function updateStudentById(studentDbId, update, detectionPayload) {
  const updated = useMockStore()
    ? mockStore.applyUpdateByInternalId(studentDbId, update)
    : await Student.findByIdAndUpdate(studentDbId, update, {
        new: true,
      });

  emitUpdate(updated);

  if (updated && detectionPayload) {
    emitDetectionEvent({
      studentName: updated.name,
      location: detectionPayload.location,
      method: detectionPayload.method,
      timestamp: detectionPayload.timestamp,
      confidence: detectionPayload.confidence,
    });
  }

  return updated;
}

async function processFusionTick() {
  if (tickRunning) {
    return;
  }

  tickRunning = true;

  try {
    const now = new Date();
    const nowMs = now.getTime();
    const cameraZone = process.env.CAMERA_ZONE || "Library - Block B";
    const frame = captureFrame();

    const students = useMockStore()
      ? mockStore.listStudents({})
      : await Student.find({});
    const studentList = students.map((student) => ({
      studentId: student.studentId,
      name: student.name,
      description: `${student.program}, Year ${student.year}`,
    }));

    let detection = await identifyStudent(frame, studentList);

    if ((!detection || !detection.studentId || detection.confidence <= 0.6) && process.env.DEMO_ACTIVE_STUDENT_ID) {
      detection = {
        studentId: process.env.DEMO_ACTIVE_STUDENT_ID,
        confidence: 0.65,
      };
    }

    if (detection && detection.studentId && detection.confidence > 0.6) {
      const matched = students.find((s) => s.studentId === detection.studentId);
      if (matched) {
        const buildingId = toBuildingId(cameraZone);
        await updateStudentById(
          matched._id,
          {
            $set: {
              status: "online",
              isOnCampus: true,
              currentLocation: {
                buildingId,
                buildingName: cameraZone,
                detectedBy: "CAMERA",
                lastSeen: now,
              },
            },
            $push: {
              locationHistory: {
                buildingId,
                buildingName: cameraZone,
                detectedBy: "CAMERA",
                timestamp: now,
              },
            },
          },
          {
            location: cameraZone,
            method: "CAMERA",
            timestamp: now,
            confidence: detection.confidence,
          }
        );
      }
    } else {
      const recentCutoff = nowMs - 3 * 60 * 1000;
      const recentStudents = students.filter((student) => {
        const lastSeen = student.currentLocation?.lastSeen
          ? new Date(student.currentLocation.lastSeen).getTime()
          : 0;
        return lastSeen >= recentCutoff;
      });

      for (const student of recentStudents) {
        const fallbackLocation =
          student.currentLocation?.buildingName || cameraZone;
        const fallbackBuildingId =
          student.currentLocation?.buildingId || toBuildingId(fallbackLocation);

        await updateStudentById(
          student._id,
          {
            $set: {
              status: "alert",
              isOnCampus: true,
              currentLocation: {
                buildingId: fallbackBuildingId,
                buildingName: fallbackLocation,
                detectedBy: "WIFI-RF",
                lastSeen: now,
              },
            },
            $push: {
              locationHistory: {
                buildingId: fallbackBuildingId,
                buildingName: fallbackLocation,
                detectedBy: "WIFI-RF",
                timestamp: now,
              },
            },
          },
          {
            location: fallbackLocation,
            method: "WIFI-RF",
            timestamp: now,
            confidence: 0,
          }
        );
      }
    }

    const offlineCutoff = nowMs - 10 * 60 * 1000;
    const staleStudents = students.filter((student) => {
      const lastSeen = student.currentLocation?.lastSeen
        ? new Date(student.currentLocation.lastSeen).getTime()
        : 0;
      return lastSeen > 0 && lastSeen < offlineCutoff;
    });

    for (const student of staleStudents) {
      await updateStudentById(
        student._id,
        {
          $set: {
            status: "offline",
            isOnCampus: false,
          },
        },
        {
          location: student.currentLocation?.buildingName || "Unknown",
          method: "SYSTEM",
          timestamp: now,
          confidence: 0,
        }
      );
    }
  } catch (error) {
    console.error("Fusion tick error:", error.message);
  } finally {
    tickRunning = false;
  }
}

function startFusionLoop(io) {
  ioRef = io;

  if (fusionTimer) {
    return;
  }

  processFusionTick();
  fusionTimer = setInterval(processFusionTick, 5000);
}

function stopFusionLoop() {
  if (!fusionTimer) {
    return;
  }

  clearInterval(fusionTimer);
  fusionTimer = null;
}

async function simulateDetection(studentId, buildingName) {
  const student = useMockStore()
    ? mockStore.getStudent(studentId)
    : await Student.findOne({ studentId });
  if (!student) {
    return null;
  }

  const now = new Date();
  const location = buildingName || process.env.CAMERA_ZONE || "Library - Block B";
  const buildingId = toBuildingId(location);

  const updated = useMockStore()
    ? mockStore.updateLocation(studentId, {
        buildingId,
        buildingName: location,
        detectedBy: "CAMERA",
        timestamp: now,
        status: "online",
      })
    : await updateStudentById(
        student._id,
        {
          $set: {
            status: "online",
            isOnCampus: true,
            currentLocation: {
              buildingId,
              buildingName: location,
              detectedBy: "CAMERA",
              lastSeen: now,
            },
          },
          $push: {
            locationHistory: {
              buildingId,
              buildingName: location,
              detectedBy: "CAMERA",
              timestamp: now,
            },
          },
        },
        {
          location,
          method: "CAMERA",
          timestamp: now,
          confidence: 1,
        }
      );

  if (useMockStore() && updated) {
    emitUpdate(updated);
    emitDetectionEvent({
      studentName: updated.name,
      location,
      method: "CAMERA",
      timestamp: now,
      confidence: 1,
    });
  }

  return updated;
}

module.exports = {
  mergeSignals,
  startFusionLoop,
  stopFusionLoop,
  simulateDetection,
};
