import { useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import useSocket from "../hooks/useSocket";

function safeDate(value) {
  const parsed = value ? new Date(value) : new Date();
  if (Number.isNaN(parsed.getTime())) {
    return new Date();
  }
  return parsed;
}

function formatDateTime(value) {
  return safeDate(value).toLocaleString();
}

function confidenceToPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  const asPercent = numeric <= 1 ? numeric * 100 : numeric;
  return Math.max(0, Math.min(100, Math.round(asPercent)));
}

export default function StudentDetail() {
  const { studentId = "" } = useParams();
  const navigate = useNavigate();
  const { students, events } = useSocket();

  const requestedId = decodeURIComponent(studentId);

  const student = useMemo(() => {
    return students.find((item) => String(item.studentId || "") === requestedId) || null;
  }, [students, requestedId]);

  const studentEvents = useMemo(() => {
    return events.filter((event) => String(event.studentId || "") === requestedId).slice(0, 12);
  }, [events, requestedId]);

  const confidenceSummary = useMemo(() => {
    if (studentEvents.length === 0) {
      return { average: 0, best: 0 };
    }

    const values = studentEvents.map((event) => confidenceToPercent(event.confidencePct || event.confidence));
    const average = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
    const best = Math.max(...values);

    return { average, best };
  }, [studentEvents]);

  const movementTrail = useMemo(() => {
    if (!student || !Array.isArray(student.locationHistory)) {
      return [];
    }

    return [...student.locationHistory]
      .sort((a, b) => safeDate(b.timestamp).getTime() - safeDate(a.timestamp).getTime())
      .slice(0, 3);
  }, [student]);

  if (!student && students.length === 0) {
    return (
      <div className="dashboard-page student-detail-page">
        <header className="stats-bar panel">
          <h1>Student Profile</h1>
          <div className="top-links">
            <Link to="/">Dashboard</Link>
            <Link to="/students">Students Added</Link>
          </div>
        </header>
        <main className="panel route-page student-detail-shell">
          <p className="muted">Loading students...</p>
        </main>
      </div>
    );
  }

  if (!student) {
    return (
      <div className="dashboard-page student-detail-page">
        <header className="stats-bar panel">
          <h1>Student Profile</h1>
          <div className="top-links">
            <Link to="/">Dashboard</Link>
            <Link to="/students">Students Added</Link>
          </div>
        </header>
        <main className="panel route-page student-detail-shell">
          <p className="muted">Student not found.</p>
          <button type="button" className="action-btn" onClick={() => navigate("/students")}>
            Back to Students Added
          </button>
        </main>
      </div>
    );
  }

  return (
    <div className="dashboard-page student-detail-page">
      <div className="scene-backdrop" aria-hidden="true">
        <span className="scene-orb scene-orb-a" />
        <span className="scene-orb scene-orb-b" />
        <span className="scene-grid-tilt" />
      </div>

      <header className="stats-bar panel">
        <h1>Student Detail</h1>
        <div className="top-links">
          <Link to="/">Dashboard</Link>
          <Link to="/students">Students Added</Link>
          <Link to={`/trail?studentId=${encodeURIComponent(student.studentId)}`}>Trail</Link>
        </div>
      </header>

      <main className="route-page student-detail-shell">
        <section className="panel student-hero">
          <div className="student-hero-copy">
            <p className="student-hero-kicker">Focused Profile View</p>
            <h2>{student.name}</h2>
            <p className="student-hero-sub">
              Monitor live status, movement history, and recognition confidence in one place.
            </p>
            <div className="student-hero-tags">
              <span className={`status-badge ${student.status || "offline"}`}>
                {student.status || "offline"}
              </span>
              <span>{student.studentId}</span>
              <span>{student.program || "Program not set"}</span>
            </div>
          </div>

          <div className="student-orbit" aria-hidden="true">
            <span className="orbit-ring orbit-ring-a" />
            <span className="orbit-ring orbit-ring-b" />
            <span className="orbit-core" />
          </div>
        </section>

        <section className="student-detail-grid">
          <article className="panel student-detail-card">
            <h3>Identity And Presence</h3>
            <p>
              <strong>Full Name:</strong> {student.name}
            </p>
            <p>
              <strong>Student ID:</strong> {student.studentId}
            </p>
            <p>
              <strong>Program:</strong> {student.program || "Not set"}
            </p>
            <p>
              <strong>Year:</strong> {student.year || "Not set"}
            </p>
            <p>
              <strong>Phone:</strong> {student.phone || "Not set"}
            </p>
            <p>
              <strong>Current Location:</strong> {student.currentLocation?.buildingName || "Unknown"}
            </p>
            <p>
              <strong>Last Seen:</strong> {formatDateTime(student.currentLocation?.lastSeen)}
            </p>
            <p>
              <strong>Added At:</strong> {formatDateTime(student.createdAt)}
            </p>
          </article>

          <article className="panel student-detail-card">
            <h3>Recognition Snapshot</h3>
            <div className="recognition-metrics">
              <div>
                <span>Recent Events</span>
                <strong>{studentEvents.length}</strong>
              </div>
              <div>
                <span>Average Confidence</span>
                <strong>{confidenceSummary.average}%</strong>
              </div>
              <div>
                <span>Best Confidence</span>
                <strong>{confidenceSummary.best}%</strong>
              </div>
            </div>

            <div className="recognition-event-list">
              {studentEvents.length === 0 ? (
                <p className="muted">No detections yet for this student.</p>
              ) : (
                studentEvents.map((event) => (
                  <article key={event.id} className="recognition-event-item">
                    <strong>{event.cameraLabel || event.location || "Unknown Camera"}</strong>
                    <p>Confidence: {confidenceToPercent(event.confidencePct || event.confidence)}%</p>
                    <small>{formatDateTime(event.timestamp)}</small>
                  </article>
                ))
              )}
            </div>
          </article>

          <article className="panel student-detail-card student-trail-card">
            <h3>Movement Timeline</h3>
            {movementTrail.length === 0 ? <p className="muted">No trail data available.</p> : null}
            {movementTrail.map((entry, index) => (
              <article className="detail-history-item" key={`${entry.timestamp}-${index}`}>
                <strong>{entry.buildingName || "Unknown Camera"}</strong>
                <p>Method: {entry.detectedBy || "CAMERA"}</p>
                <small>{formatDateTime(entry.timestamp)}</small>
              </article>
            ))}
          </article>
        </section>
      </main>
    </div>
  );
}
