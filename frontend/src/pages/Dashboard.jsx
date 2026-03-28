import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import useSocket from "../hooks/useSocket";
import { faceEngine } from "../lib/faceEngine";
import CampusMap from "../components/CampusMap";
import StudentCard from "../components/StudentCard";
import FeedPanel from "../components/FeedPanel";
import CameraGrid from "../components/CameraGrid";
import FaceRegister from "../components/FaceRegister";

const CAMERA_POSITIONS_STORAGE_KEY = "cameraPositions";
const LEGACY_CAMERA_LOCATION_STORAGE_KEY = "omni:cameraLocations:v1";
const CAMPUS_CENTER_STORAGE_KEY = "campusCenter";
const REGISTRY_STORAGE_KEY = "omni:registry:v2";
const LEGACY_REGISTRY_STORAGE_KEY = "omni:faces:v1";
const ENGINE_FACE_STORAGE_KEY = "omni_face_registry";
const DEFAULT_CAMPUS_CENTER = [28.6967, 77.4988];
const MAP_ZOOM_LEVEL = 15;
const CAMERA_POSITION_OFFSETS = [
  [0.00028, -0.00022],
  [-0.0002, 0.00024],
  [0.00018, 0.0003],
  [-0.00032, -0.00015],
  [0.00035, 0.00005],
];

function normalizePoint(value, fallback = DEFAULT_CAMPUS_CENTER) {
  if (Array.isArray(value) && value.length >= 2) {
    const lat = Number(value[0]);
    const lng = Number(value[1]);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return [lat, lng];
    }
  }

  if (value && typeof value === "object") {
    const lat = Number(value.lat);
    const lng = Number(value.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return [lat, lng];
    }
  }

  return [fallback[0], fallback[1]];
}

function pointsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length < 2 || b.length < 2) {
    return false;
  }

  return Number(a[0]) === Number(b[0]) && Number(a[1]) === Number(b[1]);
}

function looksLikeInternalCameraId(value) {
  const text = String(value || "").trim().toLowerCase();
  return text.startsWith("cam-") || /^camera-\d+$/i.test(text);
}

function resolveLocationLabel(location, cameraLabelById) {
  const buildingName = String(location?.buildingName || "").trim();
  const buildingId = String(location?.buildingId || "").trim();

  if (buildingName && cameraLabelById.has(buildingName)) {
    return String(cameraLabelById.get(buildingName));
  }

  if (buildingId && cameraLabelById.has(buildingId)) {
    return String(cameraLabelById.get(buildingId));
  }

  if (buildingName && !looksLikeInternalCameraId(buildingName)) {
    return buildingName;
  }

  if (buildingId && !looksLikeInternalCameraId(buildingId)) {
    return buildingId;
  }

  return "Unknown Camera";
}

function removeStudentFromLocalRegistries(studentId) {
  const key = String(studentId || "").trim();
  if (!key || typeof window === "undefined") {
    return;
  }

  try {
    const raw = localStorage.getItem(REGISTRY_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const next = parsed.filter((entry) => String(entry?.studentId || "") !== key);
        localStorage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify(next));
      }
    }
  } catch (error) {
    // Ignore storage parse errors so delete flow is not blocked.
  }

  try {
    const legacyRaw = localStorage.getItem(LEGACY_REGISTRY_STORAGE_KEY);
    if (legacyRaw) {
      const parsed = JSON.parse(legacyRaw);
      if (Array.isArray(parsed)) {
        const next = parsed.filter((entry) => String(entry?.personId || "") !== key);
        localStorage.setItem(LEGACY_REGISTRY_STORAGE_KEY, JSON.stringify(next));
      }
    }
  } catch (error) {
    // Ignore storage parse errors so delete flow is not blocked.
  }

  try {
    const engineRaw = localStorage.getItem(ENGINE_FACE_STORAGE_KEY);
    if (engineRaw) {
      const parsed = JSON.parse(engineRaw);
      if (Array.isArray(parsed)) {
        const next = parsed.filter((entry) => String(entry?.personId || "") !== key);
        localStorage.setItem(ENGINE_FACE_STORAGE_KEY, JSON.stringify(next));
      }
    }
  } catch (error) {
    // Ignore storage parse errors so delete flow is not blocked.
  }
}

function loadStoredCameraLocations() {
  const keys = [CAMERA_POSITIONS_STORAGE_KEY, LEGACY_CAMERA_LOCATION_STORAGE_KEY];

  try {
    for (const key of keys) {
      const raw = localStorage.getItem(key);
      if (!raw) {
        continue;
      }

      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }

      const normalized = {};
      Object.entries(parsed).forEach(([cameraKey, point]) => {
        normalized[cameraKey] = normalizePoint(point, DEFAULT_CAMPUS_CENTER);
      });

      return normalized;
    }
  } catch (error) {
    return {};
  }

  return {};
}

function loadStoredCampusCenter() {
  try {
    const raw = localStorage.getItem(CAMPUS_CENTER_STORAGE_KEY);
    if (!raw) {
      return [...DEFAULT_CAMPUS_CENTER];
    }

    const parsed = JSON.parse(raw);
    return normalizePoint(parsed, DEFAULT_CAMPUS_CENTER);
  } catch (error) {
    return [...DEFAULT_CAMPUS_CENTER];
  }
}

function defaultCameraPosition(index, center = DEFAULT_CAMPUS_CENTER) {
  const [offsetLat, offsetLng] =
    CAMERA_POSITION_OFFSETS[index % CAMERA_POSITION_OFFSETS.length];

  return [
    Number((center[0] + offsetLat).toFixed(6)),
    Number((center[1] + offsetLng).toFixed(6)),
  ];
}

function fmtTime(value) {
  if (!value) {
    return "Never";
  }
  return new Date(value).toLocaleString();
}

export default function Dashboard() {
  const {
    students,
    events,
    cameras,
    connected,
    error,
    emitEvent,
    addLocalEvent,
    deleteStudent,
  } = useSocket();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [showRegisterFace, setShowRegisterFace] = useState(false);
  const [cameraGridExpanded, setCameraGridExpanded] = useState(true);
  const [campusCenter, setCampusCenter] = useState(() => loadStoredCampusCenter());
  const [cameraLocations, setCameraLocations] = useState(() => loadStoredCameraLocations());
  const [toastMessage, setToastMessage] = useState("");
  const studentCardRefs = useRef(new Map());
  const navigate = useNavigate();

  useEffect(() => {
    if (!toastMessage) {
      return undefined;
    }

    const timer = setTimeout(() => {
      setToastMessage("");
    }, 2600);

    return () => clearTimeout(timer);
  }, [toastMessage]);

  useEffect(() => {
    const timer = setTimeout(() => {
      window.dispatchEvent(new Event("resize"));
    }, 500);

    return () => clearTimeout(timer);
  }, [cameraGridExpanded]);

  useEffect(() => {
    localStorage.setItem(CAMERA_POSITIONS_STORAGE_KEY, JSON.stringify(cameraLocations));
    localStorage.setItem(LEGACY_CAMERA_LOCATION_STORAGE_KEY, JSON.stringify(cameraLocations));
  }, [cameraLocations]);

  useEffect(() => {
    localStorage.setItem(
      CAMPUS_CENTER_STORAGE_KEY,
      JSON.stringify({ lat: campusCenter[0], lng: campusCenter[1] })
    );
  }, [campusCenter]);

  useEffect(() => {
    setCameraLocations((prev) => {
      const next = { ...prev };
      let changed = false;

      cameras.forEach((camera, index) => {
        const cameraId = String(camera.cameraId || `camera-${index + 1}`);
        const cameraLabel = String(camera.cameraLabel || `Camera ${index + 1}`);
        const existing = next[cameraId] || next[cameraLabel];

        if (existing) {
          const normalized = normalizePoint(existing, defaultCameraPosition(index, campusCenter));
          if (!next[cameraId]) {
            next[cameraId] = normalized;
            changed = true;
          } else if (!pointsEqual(next[cameraId], normalized)) {
            next[cameraId] = normalized;
            changed = true;
          }
          if (!next[cameraLabel]) {
            next[cameraLabel] = normalized;
            changed = true;
          } else if (!pointsEqual(next[cameraLabel], normalized)) {
            next[cameraLabel] = normalized;
            changed = true;
          }
          return;
        }

        const fallback = defaultCameraPosition(index, campusCenter);
        next[cameraId] = fallback;
        next[cameraLabel] = fallback;
        changed = true;
      });

      return changed ? next : prev;
    });
  }, [campusCenter, cameras]);

  const handleCampusCenterChange = useCallback((nextCenter) => {
    const normalized = normalizePoint(nextCenter, DEFAULT_CAMPUS_CENTER);
    setCampusCenter(normalized);

    if (typeof window !== "undefined") {
      localStorage.setItem(
        CAMPUS_CENTER_STORAGE_KEY,
        JSON.stringify({ lat: normalized[0], lng: normalized[1] })
      );
    }
  }, []);

  const handleCameraPositionChange = useCallback(({ cameraId, cameraLabel, position }) => {
    const normalized = normalizePoint(position, campusCenter);

    setCameraLocations((prev) => {
      const next = { ...prev };
      let changed = false;

      if (cameraId) {
        const key = String(cameraId);
        if (!pointsEqual(next[key], normalized)) {
          next[key] = normalized;
          changed = true;
        }
      }

      if (cameraLabel) {
        const key = String(cameraLabel);
        if (!pointsEqual(next[key], normalized)) {
          next[key] = normalized;
          changed = true;
        }
      }

      return changed ? next : prev;
    });
  }, [campusCenter]);

  const attachStudentCardRef = useCallback((studentId, node) => {
    const key = String(studentId || "");
    if (!key) {
      return;
    }

    if (!node) {
      studentCardRefs.current.delete(key);
      return;
    }

    studentCardRefs.current.set(key, node);
  }, []);

  const focusStudent = useCallback(
    (studentId) => {
      setSearch("");
      setSelectedId(studentId);

      window.setTimeout(() => {
        const node = studentCardRefs.current.get(studentId);
        node?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 90);
    },
    []
  );

  const handleCameraExpandedChange = useCallback((expanded) => {
    setCameraGridExpanded(Boolean(expanded));
  }, []);

  const filteredStudents = useMemo(() => {
    const key = search.trim().toLowerCase();
    if (!key) {
      return students;
    }

    return students.filter((student) => {
      return [student.name, student.studentId, student.program]
        .join(" ")
        .toLowerCase()
        .includes(key);
    });
  }, [search, students]);

  const selectedStudent = useMemo(() => {
    return students.find((student) => student.studentId === selectedId) || null;
  }, [students, selectedId]);

  useEffect(() => {
    if (!selectedId) {
      return;
    }

    const exists = students.some((student) => student.studentId === selectedId);
    if (!exists) {
      setSelectedId("");
    }
  }, [selectedId, students]);

  const cameraLabelById = useMemo(() => {
    const next = new Map();

    cameras.forEach((camera, index) => {
      const cameraId = String(camera?.cameraId || "").trim();
      const cameraLabel =
        String(camera?.cameraLabel || "").trim() || `Camera ${index + 1}`;

      if (cameraId) {
        next.set(cameraId, cameraLabel);
      }
      if (cameraLabel) {
        next.set(cameraLabel, cameraLabel);
      }
    });

    return next;
  }, [cameras]);

  const recentHistory = useMemo(() => {
    if (!selectedStudent) {
      return [];
    }

    const changes = [];
    (selectedStudent.locationHistory || []).forEach((entry) => {
      const label = resolveLocationLabel(entry, cameraLabelById);
      const previous = changes[changes.length - 1];

      if (previous && previous.label === label) {
        previous.timestamp = entry?.timestamp || previous.timestamp;
        return;
      }

      changes.push({
        ...entry,
        label,
      });
    });

    return changes.slice(-3).reverse();
  }, [cameraLabelById, selectedStudent]);

  const trailSummary = useMemo(() => {
    if (recentHistory.length === 0) {
      return "";
    }

    const ordered = recentHistory.slice().reverse();
    const labels = ordered.map((entry) => entry.label).filter(Boolean);
    return labels.length > 0 ? `${labels.join(" → ")} (last 3 locations)` : "";
  }, [recentHistory]);

  const currentLocationLabel = useMemo(() => {
    if (!selectedStudent?.currentLocation) {
      return "Unknown";
    }

    return resolveLocationLabel(selectedStudent.currentLocation, cameraLabelById);
  }, [cameraLabelById, selectedStudent]);

  const stats = useMemo(() => {
    const total = students.length;
    const onCampus = students.filter((s) => s.isOnCampus).length;
    const alert = students.filter((s) => s.status === "alert").length;
    const offline = students.filter((s) => s.status === "offline").length;
    return { total, onCampus, alert, offline };
  }, [students]);

  const handleDetection = useCallback(
    (payload) => {
      const byId = students.find((student) => student.studentId === payload.studentId);
      const byName = students.find(
        (student) =>
          student.name?.trim().toLowerCase() ===
          String(payload.studentName || "").trim().toLowerCase()
      );

      const matched = byId || byName;
      const event = {
        studentId: matched?.studentId || payload.studentId || "",
        studentName: matched?.name || payload.studentName || "Unknown",
        cameraId: payload.cameraId,
        cameraLabel: payload.cameraLabel,
        location: payload.cameraLabel,
        method: "FACE-API",
        confidence: payload.confidence ?? 0,
        timestamp: payload.timestamp || new Date().toISOString(),
      };

      addLocalEvent(event);

      emitEvent("face:detected", {
        studentId: matched?.studentId || payload.studentId,
        studentName: matched?.name || payload.studentName,
        cameraId: payload.cameraId,
        cameraLabel: payload.cameraLabel,
        confidence: payload.confidence,
        timestamp: event.timestamp,
      });

      if (matched?.studentId) {
        focusStudent(matched.studentId);
      }
    },
    [addLocalEvent, emitEvent, focusStudent, students]
  );

  const handleDeleteStudent = useCallback(
    async (student) => {
      if (!student?.studentId) {
        return;
      }

      const confirmed = window.confirm(
        `Remove ${student.name} from system? This will delete all their tracking data.`
      );
      if (!confirmed) {
        return;
      }

      try {
        await deleteStudent(student.studentId);
        faceEngine.clearPerson(student.studentId);
        removeStudentFromLocalRegistries(student.studentId);
        if (selectedId === student.studentId) {
          setSelectedId("");
        }
        setToastMessage(`${student.name} removed from system`);
      } catch (deleteError) {
        setToastMessage(`Failed to remove ${student.name}`);
      }
    },
    [deleteStudent, selectedId]
  );

  const handleFeedEventClick = useCallback(
    (event) => {
      const eventStudentId = String(event?.studentId || "").trim();
      const eventStudentName = String(event?.studentName || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

      const byName = eventStudentName
        ? students.find((student) =>
            String(student.name || "").replace(/\s+/g, " ").trim().toLowerCase() === eventStudentName
          )
        : null;
      const byId = eventStudentId
        ? students.find((student) => String(student.studentId || "") === eventStudentId)
        : null;

      const matched = byName || byId;
      if (!matched?.studentId) {
        return;
      }

      focusStudent(matched.studentId);
    },
    [focusStudent, students]
  );

  return (
    <div className="dashboard-page">
      <header className="stats-bar panel">
        <h1>Omni-Campus War Room</h1>
        <div className="top-links">
          <Link to="/search">Search</Link>
          <Link to="/trail">Trail</Link>
          <button
            type="button"
            className="action-btn"
            onClick={() => setShowRegisterFace(true)}
          >
            Register Face
          </button>
        </div>
        <div className="stats-grid">
          <div><span>Total</span><strong>{stats.total}</strong></div>
          <div><span>On Campus</span><strong>{stats.onCampus}</strong></div>
          <div><span>Alert</span><strong>{stats.alert}</strong></div>
          <div><span>Offline</span><strong>{stats.offline}</strong></div>
          <div><span>Socket</span><strong>{connected ? "Live" : "Reconnecting"}</strong></div>
          <div><span>Cameras</span><strong>{cameras.length}</strong></div>
        </div>
      </header>

      <main className="dashboard-main">
        <section className="panel camera-section expanded">
          {error ? <p className="muted">{error}</p> : null}
          <CameraGrid
            onDetection={handleDetection}
            emitEvent={emitEvent}
            socketConnected={connected}
            onExpandedChange={handleCameraExpandedChange}
          />
        </section>

        <section className="dashboard-grid bottom-grid">
          <section className="panel left-column">
            <div className="left-header">
              <h3>Students</h3>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name, ID, program"
              />
            </div>

            <div className="column-scroll">
              <div className="student-list">
                {students.length === 0 ? (
                  <p className="muted">No students registered yet. Click Register Face to add.</p>
                ) : null}

                {students.length > 0 && filteredStudents.length === 0 ? (
                  <p className="muted">No matching students</p>
                ) : null}

                {filteredStudents.map((student) => (
                  <StudentCard
                    key={student.studentId}
                    student={student}
                    selected={selectedId === student.studentId}
                    onSelect={focusStudent}
                    onDelete={handleDeleteStudent}
                    cardRef={(node) => attachStudentCardRef(student.studentId, node)}
                  />
                ))}
              </div>
            </div>
          </section>

          <CampusMap
            students={students}
            cameraLocations={cameraLocations}
            onSelectStudent={focusStudent}
            cameras={cameras}
            campusCenter={campusCenter}
            zoomLevel={MAP_ZOOM_LEVEL}
            onCampusCenterChange={handleCampusCenterChange}
            onCameraPositionChange={handleCameraPositionChange}
            isExpanded={cameraGridExpanded}
          />

          <section className="panel right-column">
            <h3>Activity + Detail</h3>
            <div className="right-column-content column-stack">
              {!selectedStudent ? <p className="muted">Select a student to inspect details.</p> : null}
              {selectedStudent ? (
                <div className="details">
                  <div className="details-head">
                    <h4>{selectedStudent.name}</h4>
                    <span className={`status-badge ${selectedStudent.status}`}>{selectedStudent.status}</span>
                  </div>
                  <p>ID: {selectedStudent.studentId}</p>
                  <p>Program: {selectedStudent.program}</p>
                  <p>Year: {selectedStudent.year}</p>
                  <p>Phone: {selectedStudent.phone}</p>
                  <p>Current location: {currentLocationLabel}</p>
                  <p>Detection method: {selectedStudent.currentLocation?.detectedBy || "N/A"}</p>
                  <p>Last seen: {fmtTime(selectedStudent.currentLocation?.lastSeen)}</p>

                  <div className="detail-history">
                    <h4>Recent Locations</h4>
                    {trailSummary ? <p className="trail-summary">{trailSummary}</p> : null}
                    {recentHistory.length === 0 ? <p className="muted">No location history yet.</p> : null}
                    {recentHistory.map((entry, idx) => (
                      <article key={`${entry.timestamp}-${idx}`} className="detail-history-item">
                        <strong>{entry.label}</strong>
                        <small>{fmtTime(entry.timestamp)}</small>
                      </article>
                    ))}
                  </div>

                  <button
                    type="button"
                    className="trail-btn"
                    onClick={() => navigate(`/trail?studentId=${selectedStudent.studentId}`)}
                  >
                    View Full Trail
                  </button>
                </div>
              ) : null}

              <FeedPanel
                events={events}
                onEventClick={handleFeedEventClick}
                selectedStudentId={selectedId}
              />
            </div>
          </section>
        </section>
      </main>

      <FaceRegister
        open={showRegisterFace}
        onClose={() => setShowRegisterFace(false)}
        emitEvent={emitEvent}
        students={students}
      />

      {toastMessage ? <div className="app-toast">{toastMessage}</div> : null}
    </div>
  );
}
