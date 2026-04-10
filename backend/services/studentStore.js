const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const descriptorCrypto = require("./descriptorCrypto");
const logger = require("./logger");

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "omni-campus.db");
const LEGACY_FILE = path.join(DATA_DIR, "students.json");
const MAX_LOCATION_HISTORY = 3;
const NAME_SIMILARITY_THRESHOLD = 0.88;

let db = null;
let statements = null;

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

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch (error) {
    return fallback;
  }
}

function normalizeDescriptor(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
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

function normalizeHistoryEntry(value) {
  const timestamp = safeDate(value?.timestamp);
  return {
    buildingId: String(value?.buildingId || "unknown-camera"),
    buildingName: String(value?.buildingName || "Unknown Camera"),
    detectedBy: String(value?.detectedBy || "CAMERA"),
    timestamp: timestamp.toISOString(),
  };
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

function buildSchema(database) {
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");

  database.exec(`
    CREATE TABLE IF NOT EXISTS students (
      student_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      program TEXT,
      year INTEGER,
      phone TEXT,
      status TEXT NOT NULL DEFAULT 'offline',
      is_on_campus INTEGER NOT NULL DEFAULT 0,
      current_location_json TEXT,
      location_history_json TEXT,
      face_descriptor_json TEXT,
      face_descriptors_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recognition_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL,
      camera_id TEXT,
      camera_label TEXT,
      confidence REAL,
      matched_at TEXT NOT NULL,
      latency_ms INTEGER,
      FOREIGN KEY(student_id) REFERENCES students(student_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_recognition_events_student_time
      ON recognition_events(student_id, matched_at DESC);
  `);
}

function prepareStatements(database) {
  statements = {
    countStudents: database.prepare("SELECT COUNT(*) AS total FROM students"),
    selectAllStudents: database.prepare("SELECT * FROM students"),
    selectStudentById: database.prepare("SELECT * FROM students WHERE student_id = ?"),
    deleteStudentById: database.prepare("DELETE FROM students WHERE student_id = ?"),
    deleteAllStudents: database.prepare("DELETE FROM students"),
    upsertStudent: database.prepare(`
      INSERT INTO students (
        student_id,
        name,
        program,
        year,
        phone,
        status,
        is_on_campus,
        current_location_json,
        location_history_json,
        face_descriptor_json,
        face_descriptors_json,
        created_at,
        updated_at
      ) VALUES (
        @student_id,
        @name,
        @program,
        @year,
        @phone,
        @status,
        @is_on_campus,
        @current_location_json,
        @location_history_json,
        @face_descriptor_json,
        @face_descriptors_json,
        @created_at,
        @updated_at
      )
      ON CONFLICT(student_id) DO UPDATE SET
        name = excluded.name,
        program = excluded.program,
        year = excluded.year,
        phone = excluded.phone,
        status = excluded.status,
        is_on_campus = excluded.is_on_campus,
        current_location_json = excluded.current_location_json,
        location_history_json = excluded.location_history_json,
        face_descriptor_json = excluded.face_descriptor_json,
        face_descriptors_json = excluded.face_descriptors_json,
        updated_at = excluded.updated_at
    `),
    insertRecognitionEvent: database.prepare(`
      INSERT INTO recognition_events (
        student_id,
        camera_id,
        camera_label,
        confidence,
        matched_at,
        latency_ms
      ) VALUES (?, ?, ?, ?, ?, ?)
    `),
  };
}

function toDbParams(student) {
  return {
    student_id: student.studentId,
    name: student.name,
    program: student.program || "",
    year: student.year === null || student.year === undefined ? null : Number(student.year),
    phone: student.phone || "",
    status: student.status || "offline",
    is_on_campus: student.isOnCampus ? 1 : 0,
    current_location_json: student.currentLocation ? JSON.stringify(student.currentLocation) : null,
    location_history_json: JSON.stringify(normalizeLocationHistory(student.locationHistory || [])),
    face_descriptor_json: descriptorCrypto.stringifyEncrypted(
      normalizeDescriptor(student.faceDescriptor || [])
    ),
    face_descriptors_json: descriptorCrypto.stringifyEncrypted(
      normalizeDescriptorHistory(student.faceDescriptors || [])
    ),
    created_at: student.createdAt,
    updated_at: student.updatedAt,
  };
}

function rowToStudent(row) {
  if (!row) {
    return null;
  }

  const normalized = normalizeStudent({
    studentId: row.student_id,
    name: row.name,
    program: row.program,
    year: row.year,
    phone: row.phone,
    status: row.status,
    isOnCampus: Boolean(row.is_on_campus),
    currentLocation: parseJson(row.current_location_json, null),
    locationHistory: parseJson(row.location_history_json, []),
    faceDescriptor: descriptorCrypto.parseEncrypted(row.face_descriptor_json, []),
    faceDescriptors: descriptorCrypto.parseEncrypted(row.face_descriptors_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  return normalized;
}

function loadAllStudents() {
  return statements.selectAllStudents.all().map(rowToStudent).filter(Boolean);
}

function countStudents() {
  const row = statements.countStudents.get();
  return Number(row?.total || 0);
}

function getStudent(studentId) {
  const key = String(studentId || "").trim();
  if (!key) {
    return null;
  }

  const row = statements.selectStudentById.get(key);
  const student = rowToStudent(row);
  return student ? clone(student) : null;
}

function saveStudent(student) {
  statements.upsertStudent.run(toDbParams(student));
  return student;
}

function findStudentBySimilarName(name) {
  let best = null;
  let bestScore = 0;

  loadAllStudents().forEach((student) => {
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

function listStudents(query = {}) {
  const q = String(query.q || "").toLowerCase().trim();
  const name = String(query.name || "").toLowerCase().trim();
  const studentId = String(query.studentId || "").toLowerCase().trim();
  const program = String(query.program || "").toLowerCase().trim();

  const filtered = loadAllStudents().filter((student) => {
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
  return clone(loadAllStudents());
}

function registerStudent(payload = {}) {
  const studentId = String(payload.studentId || "").trim();
  if (!studentId) {
    throw new Error("studentId is required");
  }

  let existing = getStudent(studentId);
  if (!existing) {
    existing = findStudentBySimilarName(payload.name);
  }

  const now = new Date().toISOString();

  if (existing) {
    const previousStudentId = existing.studentId;

    if (existing.studentId !== studentId) {
      const conflictingStudent = getStudent(studentId);
      if (!conflictingStudent) {
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
    saveStudent(existing);

    if (previousStudentId !== existing.studentId) {
      statements.deleteStudentById.run(previousStudentId);
    }

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

  saveStudent(created);
  return clone(created);
}

function updateStudent(studentId, patch = {}) {
  const student = getStudent(studentId);
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
  saveStudent(student);
  return clone(student);
}

function deleteStudent(studentId) {
  const student = getStudent(studentId);
  if (!student) {
    return null;
  }

  statements.deleteStudentById.run(student.studentId);
  return clone(student);
}

function remove(studentId) {
  return deleteStudent(studentId);
}

function updateLocation(studentId, payload = {}) {
  const student = getStudent(studentId);
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

  student.locationHistory = Array.isArray(student.locationHistory)
    ? student.locationHistory
    : [];
  student.locationHistory.unshift(locationEntry);
  if (student.locationHistory.length > MAX_LOCATION_HISTORY) {
    student.locationHistory.pop();
  }

  student.updatedAt = new Date().toISOString();
  saveStudent(student);
  return clone(student);
}

function recordRecognitionEvent({
  studentId,
  cameraId,
  cameraLabel,
  confidence,
  timestamp,
  latencyMs,
}) {
  statements.insertRecognitionEvent.run(
    String(studentId || ""),
    String(cameraId || ""),
    String(cameraLabel || ""),
    Number.isFinite(Number(confidence)) ? Number(confidence) : null,
    safeDate(timestamp).toISOString(),
    Number.isFinite(Number(latencyMs)) ? Math.round(Number(latencyMs)) : null
  );
}

function applyFaceDetection(payload = {}) {
  const studentId = String(payload.studentId || "").trim();
  if (!studentId) {
    return null;
  }

  const updated = updateLocation(studentId, {
    buildingId: payload.cameraId,
    buildingName: payload.cameraLabel,
    detectedBy: "CAMERA",
    timestamp: payload.timestamp,
    status: "online",
  });

  if (!updated) {
    return null;
  }

  recordRecognitionEvent({
    studentId,
    cameraId: payload.cameraId,
    cameraLabel: payload.cameraLabel,
    confidence: payload.confidence,
    timestamp: payload.timestamp,
    latencyMs: payload.latencyMs,
  });

  return updated;
}

function importStudents(nextStudents) {
  if (!Array.isArray(nextStudents)) {
    throw new Error("Import payload must be an array");
  }

  const normalized = nextStudents.map(normalizeStudent).filter(Boolean);
  const transaction = db.transaction((studentsToImport) => {
    statements.deleteAllStudents.run();
    studentsToImport.forEach((student) => {
      statements.upsertStudent.run(toDbParams(student));
    });
  });

  transaction(normalized);
  return clone(normalized);
}

function clearStudents() {
  const removed = exportStudents();
  statements.deleteAllStudents.run();
  return removed;
}

function getStoreInfo() {
  return {
    mode: "sqlite",
    dbFile: DB_FILE,
    descriptorEncryption: "aes-256-gcm",
  };
}

function migrateDescriptorEncryptionIfNeeded() {
  const rows = statements.selectAllStudents.all();
  if (!Array.isArray(rows) || rows.length === 0) {
    return;
  }

  const requiresMigration = rows.some((row) => {
    return (
      !descriptorCrypto.isEncryptedValue(row.face_descriptor_json)
      || !descriptorCrypto.isEncryptedValue(row.face_descriptors_json)
    );
  });

  if (!requiresMigration) {
    return;
  }

  const transaction = db.transaction((items) => {
    items.forEach((row) => {
      const student = rowToStudent(row);
      if (!student) {
        return;
      }

      statements.upsertStudent.run(toDbParams(student));
    });
  });

  transaction(rows);
  logger.info({
    service: "api",
    event: "student_store.descriptor_encryption_migrated",
    message: `Encrypted descriptor blobs for ${rows.length} student records`,
    details: {
      rows: rows.length,
    },
  });
}

function migrateFromLegacyJsonIfNeeded() {
  if (countStudents() > 0 || !fs.existsSync(LEGACY_FILE)) {
    return;
  }

  try {
    const raw = fs.readFileSync(LEGACY_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return;
    }

    const normalized = parsed.map(normalizeStudent).filter(Boolean);
    const transaction = db.transaction((items) => {
      items.forEach((student) => {
        statements.upsertStudent.run(toDbParams(student));
      });
    });

    transaction(normalized);
    logger.info({
      service: "api",
      event: "student_store.legacy_migration_complete",
      message: `Migrated ${normalized.length} student records from students.json to SQLite`,
      details: {
        rows: normalized.length,
      },
    });
  } catch (error) {
    logger.warn({
      service: "api",
      event: "student_store.legacy_migration_skipped",
      message: `Legacy JSON migration skipped: ${error.message}`,
      details: {
        reason: error.message,
      },
    });
  }
}

function initializeStore() {
  if (db) {
    return;
  }

  ensureStoragePath();
  db = new Database(DB_FILE);
  buildSchema(db);
  prepareStatements(db);
  migrateFromLegacyJsonIfNeeded();
  migrateDescriptorEncryptionIfNeeded();
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
  getStoreInfo,
};
