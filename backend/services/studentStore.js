const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "students.json");
const MAX_LOCATION_HISTORY = 10;
const NAME_SIMILARITY_THRESHOLD = 0.88;

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

function normalizeNameForComparison(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function levenshteinDistance(a, b) {
  if (a === b) {
    return 0;
  }

  if (!a.length) {
    return b.length;
  }

  if (!b.length) {
    return a.length;
  }

  const matrix = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0)
  );

  for (let i = 0; i <= a.length; i += 1) {
    matrix[i][0] = i;
  }

  for (let j = 0; j <= b.length; j += 1) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  return matrix[a.length][b.length];
}

function computeNameSimilarity(candidate, query) {
  const a = normalizeNameForComparison(candidate);
  const b = normalizeNameForComparison(query);

  if (!a || !b) {
    return 0;
  }

  if (a === b) {
    return 1;
  }

  if (a.includes(b) || b.includes(a)) {
    return 0.94;
  }

  const distance = levenshteinDistance(a, b);
  const denominator = Math.max(a.length, b.length);
  if (!denominator) {
    return 0;
  }

  return Math.max(0, 1 - distance / denominator);
}

function findStudentBySimilarName(name) {
  let best = null;
  let bestScore = 0;

  students.forEach((student) => {
    const score = computeNameSimilarity(student.name, name);
    if (score > bestScore) {
      best = student;
      bestScore = score;
    }
  });

  if (bestScore < NAME_SIMILARITY_THRESHOLD) {
    return null;
  }

  return best;
}

function normalizeDescriptorHistory(value) {
  const fromPayload = Array.isArray(value) ? value : [];
  return fromPayload
    .map((entry) => normalizeDescriptor(entry))
    .filter((entry) => entry.length > 0);
}

function descriptorKey(descriptor) {
  return normalizeDescriptor(descriptor)
    .map((value) => value.toFixed(6))
    .join(",");
}

function mergeDescriptorHistory(existing, incoming) {
  const result = [];
  const seen = new Set();

  const pushDescriptor = (descriptor) => {
    const normalized = normalizeDescriptor(descriptor);
    if (normalized.length === 0) {
      return;
    }

    const key = descriptorKey(normalized);
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    result.push(normalized);
  };

  normalizeDescriptorHistory(existing).forEach(pushDescriptor);
  normalizeDescriptorHistory(incoming).forEach(pushDescriptor);

  return result;
}

function normalizeLocationHistory(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = value.map(normalizeHistoryEntry);
  normalized.sort(
    (a, b) => safeDate(b.timestamp).getTime() - safeDate(a.timestamp).getTime()
  );

  return normalized.slice(0, MAX_LOCATION_HISTORY);
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

  const descriptorHistory = mergeDescriptorHistory(
    input.faceDescriptors,
    Array.isArray(input.faceDescriptor) && input.faceDescriptor.length > 0
      ? [input.faceDescriptor]
      : []
  );
  const history = normalizeLocationHistory(input.locationHistory);

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
    faceDescriptor:
      descriptorHistory[descriptorHistory.length - 1] || normalizeDescriptor(input.faceDescriptor),
    faceDescriptors: descriptorHistory,
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
  const key = String(studentId || "").trim();
  const found = students.find(
    (item) => item.studentId === key || String(item._id || "") === key
  );
  return found ? clone(found) : null;
}

function registerStudent(payload = {}) {
  const studentId = String(payload.studentId || "").trim();
  if (!studentId) {
    throw new Error("studentId is required");
  }

  let existing = students.find((item) => item.studentId === studentId);
  if (!existing) {
    existing = findStudentBySimilarName(payload.name);
  }

  const now = new Date().toISOString();

  if (existing) {
    if (existing.studentId !== studentId) {
      const conflictingStudentId = students.find(
        (item) => item !== existing && item.studentId === studentId
      );

      if (!conflictingStudentId) {
        existing.studentId = studentId;
      }
    }

    existing.name = String(payload.name || existing.name || "Unknown").trim() || "Unknown";
    existing.program = String(payload.program || existing.program || "").trim();
    existing.year =
      payload.year === undefined || payload.year === null || payload.year === ""
        ? existing.year
        : Number(payload.year);
    existing.phone = String(payload.phone || existing.phone || "").trim();

    const descriptor = normalizeDescriptor(payload.faceDescriptor);
    if (descriptor.length > 0) {
      existing.faceDescriptors = mergeDescriptorHistory(existing.faceDescriptors, [descriptor]);
      existing.faceDescriptor =
        existing.faceDescriptors[existing.faceDescriptors.length - 1] || descriptor;
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
    faceDescriptors: [payload.faceDescriptor],
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
  const key = String(studentId || "").trim();
  const index = students.findIndex(
    (item) => item.studentId === key || String(item._id || "") === key
  );
  if (index < 0) {
    return null;
  }

  const [removed] = students.splice(index, 1);
  saveStore();
  return clone(removed);
}

function updateLocation(studentId, payload = {}) {
  const key = String(studentId || "").trim();
  const student = students.find(
    (item) => item.studentId === key || String(item._id || "") === key
  );
  if (!student) {
    return null;
  }

  const eventTime = safeDate(payload.timestamp);
  const buildingId = String(payload.buildingId || payload.cameraId || "unknown-camera");
  const buildingName = String(payload.buildingName || payload.cameraLabel || "Unknown Camera");
  const locationEntry = {
    buildingId,
    buildingName,
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
  if (!Array.isArray(student.locationHistory)) {
    student.locationHistory = [];
  }

  student.locationHistory.unshift(locationEntry);
  if (student.locationHistory.length > MAX_LOCATION_HISTORY) {
    student.locationHistory.pop();
  }

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

function remove(studentId) {
  return deleteStudent(studentId);
}

function clearStudents() {
  const removed = clone(students);
  students = [];
  saveStore();
  return removed;
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
  remove,
  clearStudents,
  updateLocation,
  applyFaceDetection,
  importStudents,
};
