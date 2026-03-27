import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import useSocket from "../hooks/useSocket";
import CampusMap from "../components/CampusMap";
import StudentCard from "../components/StudentCard";
import FeedPanel from "../components/FeedPanel";
import VideoFeed from "../components/VideoFeed";

function fmtTime(value) {
  if (!value) {
    return "Never";
  }
  return new Date(value).toLocaleString();
}

export default function Dashboard() {
  const { students, events, connected, error } = useSocket();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [showTrail, setShowTrail] = useState(false);
  const navigate = useNavigate();

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

  const stats = useMemo(() => {
    const total = students.length;
    const onCampus = students.filter((s) => s.isOnCampus).length;
    const alert = students.filter((s) => s.status === "alert").length;
    const offline = students.filter((s) => s.status === "offline").length;
    return { total, onCampus, alert, offline };
  }, [students]);

  return (
    <div className="dashboard-page">
      <header className="stats-bar panel">
        <h1>Omni-Campus War Room</h1>
        <div className="top-links">
          <Link to="/search">Search</Link>
          <Link to="/trail">Trail</Link>
        </div>
        <div className="stats-grid">
          <div><span>Total</span><strong>{stats.total}</strong></div>
          <div><span>On Campus</span><strong>{stats.onCampus}</strong></div>
          <div><span>Alert</span><strong>{stats.alert}</strong></div>
          <div><span>Offline</span><strong>{stats.offline}</strong></div>
          <div><span>Socket</span><strong>{connected ? "Live" : "Reconnecting"}</strong></div>
        </div>
      </header>

      <main className="dashboard-grid">
        <section className="panel left-column">
          {error ? <p className="muted">{error}</p> : null}
          <div className="left-header">
            <h3>Students</h3>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, ID, program"
            />
          </div>

          <div className="student-list">
            {filteredStudents.map((student) => (
              <StudentCard
                key={student.studentId}
                student={student}
                selected={selectedId === student.studentId}
                onSelect={setSelectedId}
              />
            ))}
            {filteredStudents.length === 0 ? <p className="muted">No matching students</p> : null}
          </div>
        </section>

        <CampusMap students={students} onSelectStudent={setSelectedId} />

        <section className="panel right-column">
          <h3>Command Panel</h3>
          <VideoFeed />
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
              <p>Current location: {selectedStudent.currentLocation?.buildingName || "Unknown"}</p>
              <p>Detection method: {selectedStudent.currentLocation?.detectedBy || "N/A"}</p>
              <p>Last seen: {fmtTime(selectedStudent.currentLocation?.lastSeen)}</p>
              <button type="button" className="trail-btn" onClick={() => setShowTrail(true)}>
                View Trail
              </button>
              <button
                type="button"
                className="trail-btn"
                onClick={() => navigate(`/trail?studentId=${selectedStudent.studentId}`)}
              >
                Open Trail Page
              </button>
            </div>
          ) : null}

          <FeedPanel events={events} />
        </section>
      </main>

      {showTrail && selectedStudent ? (
        <div className="modal-backdrop" onClick={() => setShowTrail(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{selectedStudent.name} - Movement Trail</h3>
              <button type="button" className="close-btn" onClick={() => setShowTrail(false)}>X</button>
            </div>
            <div className="trail-list">
              {(selectedStudent.locationHistory || []).length === 0 ? (
                <p className="muted">No location history yet.</p>
              ) : (
                selectedStudent.locationHistory
                  .slice()
                  .reverse()
                  .map((entry, idx) => (
                    <article key={`${entry.timestamp}-${idx}`} className="trail-item">
                      <strong>{entry.buildingName}</strong>
                      <p>Method: {entry.detectedBy}</p>
                      <small>{fmtTime(entry.timestamp)}</small>
                    </article>
                  ))
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
