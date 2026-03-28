import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import useSocket from "../hooks/useSocket";
import CampusMap from "../components/CampusMap";
import StudentCard from "../components/StudentCard";
import FeedPanel from "../components/FeedPanel";
import CameraGrid from "../components/CameraGrid";
import FaceRegister from "../components/FaceRegister";

const CAMERA_LOCATION_STORAGE_KEY = "omni:cameraLocations:v1";
const DEFAULT_CAMERA_POSITIONS = [
  [12.97195, 77.59415],
  [12.97135, 77.59515],
  [12.97225, 77.59395],
];
const FEED_DEDUPE_MS = 8000;

function loadStoredCameraLocations() {
  try {
    const raw = localStorage.getItem(CAMERA_LOCATION_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    return {};
  }
}

function defaultCameraPosition(index) {
  return DEFAULT_CAMERA_POSITIONS[index % DEFAULT_CAMERA_POSITIONS.length];
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
  } = useSocket();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [showRegisterFace, setShowRegisterFace] = useState(false);
  const [cameraGridExpanded, setCameraGridExpanded] = useState(true);
  const [cameraLocations, setCameraLocations] = useState(() => loadStoredCameraLocations());
  const studentCardRefs = useRef(new Map());
  const lastDetectionTimeRef = useRef(new Map());
  const navigate = useNavigate();

  useEffect(() => {
    const timer = setTimeout(() => {
      window.dispatchEvent(new Event("resize"));
    }, 500);

    return () => clearTimeout(timer);
  }, [cameraGridExpanded]);

  useEffect(() => {
    localStorage.setItem(CAMERA_LOCATION_STORAGE_KEY, JSON.stringify(cameraLocations));
  }, [cameraLocations]);

  useEffect(() => {
    setCameraLocations((prev) => {
      const next = { ...prev };
      let changed = false;

      cameras.forEach((camera, index) => {
        const cameraId = String(camera.cameraId || `camera-${index + 1}`);
        const cameraLabel = String(camera.cameraLabel || `Camera ${index + 1}`);
        const existing = next[cameraId] || next[cameraLabel];

        if (existing) {
          if (!next[cameraId]) {
            next[cameraId] = existing;
            changed = true;
          }
          if (!next[cameraLabel]) {
            next[cameraLabel] = existing;
            changed = true;
          }
          return;
        }

        const fallback = defaultCameraPosition(index);
        next[cameraId] = fallback;
        next[cameraLabel] = fallback;
        changed = true;
      });

      if (!next["Camera 1"]) {
        next["Camera 1"] = DEFAULT_CAMERA_POSITIONS[0];
        next["camera-1"] = DEFAULT_CAMERA_POSITIONS[0];
        changed = true;
      }
      if (!next["Camera 2"]) {
        next["Camera 2"] = DEFAULT_CAMERA_POSITIONS[1];
        next["camera-2"] = DEFAULT_CAMERA_POSITIONS[1];
        changed = true;
      }
      if (!next["Camera 3"]) {
        next["Camera 3"] = DEFAULT_CAMERA_POSITIONS[2];
        next["camera-3"] = DEFAULT_CAMERA_POSITIONS[2];
        changed = true;
      }

      return changed ? next : prev;
    });
  }, [cameras]);

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

  const recentHistory = useMemo(() => {
    if (!selectedStudent) {
      return [];
    }

    return (selectedStudent.locationHistory || []).slice().reverse().slice(0, 10);
  }, [selectedStudent]);

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

      const dedupeKey = String(event.studentId || "").trim();
      const now = Date.now();
      const last = lastDetectionTimeRef.current.get(dedupeKey) || 0;
      const shouldAddFeed = !dedupeKey || now - last > FEED_DEDUPE_MS;

      if (shouldAddFeed) {
        addLocalEvent(event);
        if (dedupeKey) {
          lastDetectionTimeRef.current.set(dedupeKey, now);
        }
      }

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
        <section className={`panel camera-section ${cameraGridExpanded ? "expanded" : "collapsed"}`}>
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
            isExpanded={cameraGridExpanded}
          />

          <section className="panel right-column">
            <h3>Activity + Detail</h3>
            <div className="column-scroll column-stack">
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
                  <p>
                    Current camera: {selectedStudent.currentLocation?.buildingId || selectedStudent.currentLocation?.buildingName || "Unknown"}
                  </p>
                  <p>
                    Current location: {selectedStudent.currentLocation?.buildingName || "Unknown"}
                    {selectedStudent.currentLocation?.buildingId
                      ? ` (${selectedStudent.currentLocation.buildingId})`
                      : ""}
                  </p>
                  <p>Detection method: {selectedStudent.currentLocation?.detectedBy || "N/A"}</p>
                  <p>Last seen: {fmtTime(selectedStudent.currentLocation?.lastSeen)}</p>

                  <div className="detail-history">
                    <h4>Recent Locations</h4>
                    {recentHistory.length === 0 ? <p className="muted">No location history yet.</p> : null}
                    {recentHistory.map((entry, idx) => (
                      <article key={`${entry.timestamp}-${idx}`} className="detail-history-item">
                        <strong>{entry.buildingName}</strong>
                        <p>{entry.detectedBy}</p>
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
    </div>
  );
}
