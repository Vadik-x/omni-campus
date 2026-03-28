const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "students.json");

let students = [];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeDate(value) {
  const parsed = value ? new Date(value) : new Date();
  if (Number.isNaN(parsed.getTime())) {
    return new Date();
  }
  return parsed;
}

function ensureStoragePath() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function saveStore() {
  ensureStoragePath();
  fs.writeFileSync(DATA_FILE, JSON.stringify(students, null, 2), "utf-8");
}

function normalizeDescriptor(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
}

function normalizeHistoryEntry(value) {
  const timestamp = safeDate(value?.timestamp);
  return {
    buildingId: String(value?.buildingId || "unknown-camera"),
    buildingName: String(value?.buildingName || "Unknown Camera"),
    detectedBy: String(value?.detectedBy || "CAMERA"),
    timestamp: timestamp.toISOString(),
  };
}

function normalizeStudent(input = {}) {
  const now = new Date().toISOString();
  const studentId = String(input.studentId || "").trim();
  if (!studentId) {
    return null;
  }

  const history = Array.isArray(input.locationHistory)
    ? input.locationHistory.map(normalizeHistoryEntry).slice(-50)
    : [];

  const currentLocation = input.currentLocation
    ? {
        buildingId: String(input.currentLocation.buildingId || "unknown-camera"),
        buildingName: String(input.currentLocation.buildingName || "Unknown Camera"),
        detectedBy: String(input.currentLocation.detectedBy || "CAMERA"),
        lastSeen: safeDate(input.currentLocation.lastSeen).toISOString(),
      }
    : null;

  return {
    studentId,
    name: String(input.name || "Unknown").trim() || "Unknown",
    program: String(input.program || "").trim(),
    year:
      input.year === null || input.year === undefined || input.year === ""
        ? null
        : Number(input.year),
    phone: String(input.phone || "").trim(),
    faceDescriptor: normalizeDescriptor(input.faceDescriptor),
    status: ["online", "offline", "alert"].includes(input.status)
      ? input.status
      : "offline",
    currentLocation,
    locationHistory: history,
    isOnCampus: Boolean(input.isOnCampus),
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now,
  };
}

function initializeStore() {
  ensureStoragePath();

  if (!fs.existsSync(DATA_FILE)) {
    students = [];
    saveStore();
    return;
  }

  try {
    const raw = fs.readFileSync(DATA_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      students = [];
      saveStore();
      return;
    }

    students = parsed.map(normalizeStudent).filter(Boolean);
    saveStore();
  } catch (error) {
    students = [];
    saveStore();
  }
}

function countStudents() {
  return students.length;
}

function listStudents(query = {}) {
  const q = String(query.q || "").toLowerCase().trim();
  const name = String(query.name || "").toLowerCase().trim();
  const studentId = String(query.studentId || "").toLowerCase().trim();
  const program = String(query.program || "").toLowerCase().trim();

  const filtered = students.filter((student) => {
    const haystack = `${student.name} ${student.studentId} ${student.program}`.toLowerCase();
    if (q && !haystack.includes(q)) {
      return false;
    }

    if (name && !student.name.toLowerCase().includes(name)) {
      return false;
    }

    if (studentId && !student.studentId.toLowerCase().includes(studentId)) {
      return false;
    }

    if (program && !student.program.toLowerCase().includes(program)) {
      return false;
    }

    return true;
  });

  return clone(filtered.sort((a, b) => a.name.localeCompare(b.name)));
}

function exportStudents() {
  return clone(students);
}

function getStudent(studentId) {
  const found = students.find((item) => item.studentId === studentId);
  return found ? clone(found) : null;
}

function registerStudent(payload = {}) {
  const studentId = String(payload.studentId || "").trim();
  if (!studentId) {
    throw new Error("studentId is required");
  }

  const existing = students.find((item) => item.studentId === studentId);
  const now = new Date().toISOString();

  if (existing) {
    existing.name = String(payload.name || existing.name || "Unknown").trim() || "Unknown";
    existing.program = String(payload.program || existing.program || "").trim();
    existing.year =
      payload.year === undefined || payload.year === null || payload.year === ""
        ? existing.year
        : Number(payload.year);
    existing.phone = String(payload.phone || existing.phone || "").trim();

    const descriptor = normalizeDescriptor(payload.faceDescriptor);
    if (descriptor.length > 0) {
      existing.faceDescriptor = descriptor;
    }

    existing.updatedAt = now;
    saveStore();
    return clone(existing);
  }

  const created = normalizeStudent({
    studentId,
    name: payload.name,
    program: payload.program,
    year: payload.year,
    phone: payload.phone,
    faceDescriptor: payload.faceDescriptor,
    status: "offline",
    isOnCampus: false,
    currentLocation: null,
    locationHistory: [],
    createdAt: now,
    updatedAt: now,
  });

  students.push(created);
  saveStore();
  return clone(created);
}

function updateStudent(studentId, patch = {}) {
  const student = students.find((item) => item.studentId === studentId);
  if (!student) {
    return null;
  }

  const allowed = ["name", "program", "year", "phone"];
  for (const key of allowed) {
    if (!(key in patch)) {
      continue;
    }

    if (key === "year") {
      student.year =
        patch.year === null || patch.year === undefined || patch.year === ""
          ? null
          : Number(patch.year);
    } else {
      student[key] = String(patch[key] || "").trim();
    }
  }

  student.updatedAt = new Date().toISOString();
  saveStore();
  return clone(student);
}

function deleteStudent(studentId) {
  const index = students.findIndex((item) => item.studentId === studentId);
  if (index < 0) {
    return null;
  }

  const [removed] = students.splice(index, 1);
  saveStore();
  return clone(removed);
}

function updateLocation(studentId, payload = {}) {
  const student = students.find((item) => item.studentId === studentId);
  if (!student) {
    return null;
  }

  const eventTime = safeDate(payload.timestamp);
  const locationEntry = {
    buildingId: String(payload.buildingId || "unknown-camera"),
    buildingName: String(payload.buildingName || "Unknown Camera"),
    detectedBy: String(payload.detectedBy || "CAMERA"),
    timestamp: eventTime.toISOString(),
  };

  student.status = String(payload.status || "online");
  student.isOnCampus = true;
  student.currentLocation = {
    buildingId: locationEntry.buildingId,
    buildingName: locationEntry.buildingName,
    detectedBy: locationEntry.detectedBy,
    lastSeen: eventTime.toISOString(),
  };
  student.locationHistory = [...student.locationHistory, locationEntry].slice(-50);
  student.updatedAt = new Date().toISOString();

  saveStore();
  return clone(student);
}

function applyFaceDetection(payload = {}) {
  const studentId = String(payload.studentId || "").trim();
  if (!studentId) {
    return null;
  }

  const student = students.find((item) => item.studentId === studentId);
  if (!student) {
    return null;
  }

  return updateLocation(studentId, {
    buildingId: payload.cameraId,
    buildingName: payload.cameraLabel,
    detectedBy: "CAMERA",
    timestamp: payload.timestamp,
    status: "online",
  });
}

function importStudents(nextStudents) {
  if (!Array.isArray(nextStudents)) {
    throw new Error("Import payload must be an array");
  }

  students = nextStudents.map(normalizeStudent).filter(Boolean);
  saveStore();
  return clone(students);
}

module.exports = {
  initializeStore,
  countStudents,
  listStudents,
  exportStudents,
  getStudent,
  registerStudent,
  updateStudent,
  deleteStudent,
  updateLocation,
  applyFaceDetection,
  importStudents,
};
