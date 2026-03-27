const PLACEHOLDER_PHOTO =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/w8AAgMBgkM8nwsAAAAASUVORK5CYII=";

const baseStudents = [
  { studentId: "OC1001", name: "Aarav Sharma", program: "B.Tech CSE", year: 2, phone: "9876501201" },
  { studentId: "OC1002", name: "Ishita Verma", program: "B.Tech CSE", year: 3, phone: "9876501202" },
  { studentId: "OC1003", name: "Rohan Kulkarni", program: "B.Tech CSE", year: 1, phone: "9876501203" },
  { studentId: "OC1004", name: "Meera Nair", program: "B.Tech ECE", year: 4, phone: "9876501204" },
  { studentId: "OC1005", name: "Karthik Reddy", program: "B.Tech ECE", year: 2, phone: "9876501205" },
  { studentId: "OC1006", name: "Sana Qureshi", program: "B.Tech ECE", year: 1, phone: "9876501206" },
  { studentId: "OC1007", name: "Aditya Menon", program: "MBA", year: 1, phone: "9876501207" },
  { studentId: "OC1008", name: "Priya Deshpande", program: "MBA", year: 2, phone: "9876501208" },
  { studentId: "OC1009", name: "Harsh Jain", program: "MBA", year: 1, phone: "9876501209" },
  { studentId: "OC1010", name: "Ananya Iyer", program: "B.Sc Physics", year: 3, phone: "9876501210" },
  { studentId: "OC1011", name: "Dev Patel", program: "B.Sc Physics", year: 2, phone: "9876501211" },
  { studentId: "OC1012", name: "Neha Bansal", program: "B.Sc Physics", year: 1, phone: "9876501212" },
  { studentId: "OC1013", name: "Rahul Tripathi", program: "MBBS", year: 3, phone: "9876501213" },
  { studentId: "OC1014", name: "Sneha Kapoor", program: "MBBS", year: 2, phone: "9876501214" },
  { studentId: "OC1015", name: "Vikram Singh", program: "MBBS", year: 1, phone: "9876501215" },
  { studentId: "OC1016", name: "Tanya Chawla", program: "B.Arch", year: 4, phone: "9876501216" },
  { studentId: "OC1017", name: "Arjun Bhatt", program: "B.Arch", year: 3, phone: "9876501217" },
  { studentId: "OC1018", name: "Nidhi Rao", program: "B.Arch", year: 2, phone: "9876501218" },
  { studentId: "OC1019", name: "Yash Gupta", program: "B.Tech CSE", year: 4, phone: "9876501219" },
  { studentId: "OC1020", name: "Pooja Mishra", program: "B.Tech ECE", year: 3, phone: "9876501220" },
];

function clone(data) {
  return JSON.parse(JSON.stringify(data));
}

function buildInitialStudents() {
  return baseStudents.map((student, index) => ({
    ...student,
    _id: `mock-${index + 1}`,
    photo: PLACEHOLDER_PHOTO,
    status: "offline",
    isOnCampus: false,
    currentLocation: null,
    locationHistory: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
}

let students = buildInitialStudents();

function resetMockStore() {
  students = buildInitialStudents();
}

function matches(student, query = {}) {
  const toText = (value) => String(value || "").toLowerCase();
  const q = toText(query.q);
  const byName = toText(query.name);
  const byId = toText(query.studentId);
  const byProgram = toText(query.program);

  const haystack = `${student.name} ${student.studentId} ${student.program}`.toLowerCase();
  if (q && !haystack.includes(q)) {
    return false;
  }
  if (byName && !toText(student.name).includes(byName)) {
    return false;
  }
  if (byId && !toText(student.studentId).includes(byId)) {
    return false;
  }
  if (byProgram && !toText(student.program).includes(byProgram)) {
    return false;
  }

  return true;
}

function listStudents(query) {
  return clone(students.filter((student) => matches(student, query)).sort((a, b) => a.name.localeCompare(b.name)));
}

function getStudent(studentId) {
  const student = students.find((item) => item.studentId === studentId);
  return student ? clone(student) : null;
}

function createStudent(payload) {
  if (students.some((item) => item.studentId === payload.studentId)) {
    const duplicateError = new Error("studentId already exists");
    duplicateError.code = 11000;
    throw duplicateError;
  }

  const next = {
    _id: `mock-${Date.now()}`,
    studentId: payload.studentId,
    name: payload.name,
    program: payload.program,
    year: payload.year,
    phone: payload.phone,
    photo: payload.photo || PLACEHOLDER_PHOTO,
    status: payload.status || "offline",
    isOnCampus: Boolean(payload.isOnCampus),
    currentLocation: payload.currentLocation || null,
    locationHistory: payload.locationHistory || [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  students.push(next);
  return clone(next);
}

function updateLocation(studentId, { buildingId, buildingName, detectedBy, timestamp, status }) {
  const student = students.find((item) => item.studentId === studentId);
  if (!student) {
    return null;
  }

  const eventTime = timestamp ? new Date(timestamp) : new Date();
  student.currentLocation = {
    buildingId,
    buildingName,
    detectedBy,
    lastSeen: eventTime.toISOString(),
  };

  student.locationHistory.push({
    buildingId,
    buildingName,
    detectedBy,
    timestamp: eventTime.toISOString(),
  });

  student.status = status || "online";
  student.isOnCampus = true;
  student.updatedAt = new Date().toISOString();

  return clone(student);
}

function applyMergedDetection(studentId, mergedSignal) {
  return updateLocation(studentId, {
    buildingId: mergedSignal.buildingId,
    buildingName: mergedSignal.buildingName,
    detectedBy: mergedSignal.detectedBy,
    timestamp: mergedSignal.timestamp,
    status: "online",
  });
}

function applyUpdateByInternalId(internalId, update = {}) {
  const student = students.find((item) => item._id === String(internalId));
  if (!student) {
    return null;
  }

  if (update.$set && typeof update.$set === "object") {
    Object.entries(update.$set).forEach(([key, value]) => {
      student[key] = value;
    });
  }

  if (update.$push && typeof update.$push === "object") {
    Object.entries(update.$push).forEach(([key, value]) => {
      if (!Array.isArray(student[key])) {
        student[key] = [];
      }
      student[key].push(value);
    });
  }

  student.updatedAt = new Date().toISOString();
  return clone(student);
}

module.exports = {
  listStudents,
  getStudent,
  createStudent,
  updateLocation,
  applyMergedDetection,
  applyUpdateByInternalId,
  resetMockStore,
};
