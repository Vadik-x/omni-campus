const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "students.json");
const MAX_LOCATION_HISTORY = 10;

let students = [];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureStoragePath() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function save() {
  ensureStoragePath();
  fs.writeFileSync(DATA_FILE, JSON.stringify(students, null, 2), "utf-8");
}

function normalizeStudent(input = {}) {
  const now = new Date().toISOString();
  const studentId = String(input.studentId || "").trim();
  if (!studentId) {
    return null;
  }

  return {
    studentId,
    name: String(input.name || "Unknown").trim() || "Unknown",
    program: String(input.program || "").trim(),
    year:
      input.year === null || input.year === undefined || input.year === ""
        ? null
        : Number(input.year),
    phone: String(input.phone || "").trim(),
    faceDescriptor: Array.isArray(input.faceDescriptor)
      ? input.faceDescriptor
          .map((item) => Number(item))
          .filter((item) => Number.isFinite(item))
      : [],
    status: ["online", "offline", "alert"].includes(input.status)
      ? input.status
      : "offline",
    isOnCampus: Boolean(input.isOnCampus),
    currentLocation: input.currentLocation || null,
    locationHistory: Array.isArray(input.locationHistory)
      ? input.locationHistory.slice(0, MAX_LOCATION_HISTORY)
      : [],
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now,
  };
}

function initialize() {
  ensureStoragePath();

  if (!fs.existsSync(DATA_FILE)) {
    students = [];
    save();
    return;
  }

  try {
    const raw = fs.readFileSync(DATA_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      students = [];
      save();
      return;
    }

    students = parsed.map(normalizeStudent).filter(Boolean);
    save();
  } catch (error) {
    students = [];
    save();
  }
}

function getAll() {
  return clone(students);
}

function getById(id) {
  const studentId = String(id || "").trim();
  const found = students.find((item) => item.studentId === studentId);
  return found ? clone(found) : null;
}

function upsert(student) {
  const normalized = normalizeStudent(student);
  if (!normalized) {
    throw new Error("studentId is required");
  }

  const index = students.findIndex((item) => item.studentId === normalized.studentId);
  if (index >= 0) {
    const existing = students[index];
    students[index] = {
      ...existing,
      ...normalized,
      createdAt: existing.createdAt || normalized.createdAt,
      updatedAt: new Date().toISOString(),
    };
    save();
    return clone(students[index]);
  }

  students.push(normalized);
  save();
  return clone(normalized);
}

function updateLocation(id, locationData = {}) {
  const studentId = String(id || "").trim();
  const student = students.find((item) => item.studentId === studentId);
  if (!student) {
    return null;
  }

  const timestamp = locationData.timestamp
    ? new Date(locationData.timestamp)
    : new Date();
  const safeTime = Number.isNaN(timestamp.getTime()) ? new Date() : timestamp;

  const buildingId = String(
    locationData.buildingId || locationData.cameraId || "unknown-camera"
  );
  const buildingName = String(
    locationData.buildingName || locationData.cameraLabel || "Unknown Camera"
  );

  const entry = {
    buildingId,
    buildingName,
    detectedBy: String(locationData.detectedBy || "CAMERA"),
    timestamp: safeTime.toISOString(),
  };

  student.currentLocation = {
    buildingId: entry.buildingId,
    buildingName: entry.buildingName,
    detectedBy: entry.detectedBy,
    lastSeen: safeTime.toISOString(),
  };
  if (!Array.isArray(student.locationHistory)) {
    student.locationHistory = [];
  }

  student.locationHistory.unshift(entry);
  if (student.locationHistory.length > MAX_LOCATION_HISTORY) {
    student.locationHistory.pop();
  }

  student.status = String(locationData.status || "online");
  student.isOnCampus = true;
  student.updatedAt = new Date().toISOString();

  save();
  return clone(student);
}

function remove(id) {
  const studentId = String(id || "").trim();
  const index = students.findIndex((item) => item.studentId === studentId);
  if (index < 0) {
    return null;
  }

  const [deleted] = students.splice(index, 1);
  save();
  return clone(deleted);
}

function removeAll() {
  const removed = clone(students);
  students = [];
  save();
  return removed;
}

initialize();

module.exports = {
  getAll,
  getById,
  upsert,
  updateLocation,
  remove,
  removeAll,
};
