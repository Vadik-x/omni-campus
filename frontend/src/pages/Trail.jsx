import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import useSocket from "../hooks/useSocket";

function fmtTime(value) {
  if (!value) {
    return "Never";
  }
  return new Date(value).toLocaleString();
}

export default function Trail() {
  const { students } = useSocket();
  const [params, setParams] = useSearchParams();
  const [localId, setLocalId] = useState(params.get("studentId") || "");

  const selectedId = params.get("studentId") || localId;
  const selectedStudent = useMemo(() => {
    return students.find((s) => s.studentId === selectedId) || null;
  }, [students, selectedId]);

  return (
    <div className="dashboard-page">
      <header className="stats-bar panel">
        <h1>Movement Trail</h1>
        <div className="top-links">
          <Link to="/">Dashboard</Link>
          <Link to="/search">Search</Link>
        </div>
      </header>

      <main className="panel route-page">
        <div className="trail-toolbar">
          <label htmlFor="studentId">Select Student</label>
          <select
            id="studentId"
            value={selectedId}
            onChange={(e) => {
              const value = e.target.value;
              setLocalId(value);
              if (value) {
                setParams({ studentId: value });
              } else {
                setParams({});
              }
            }}
          >
            <option value="">Choose...</option>
            {students.map((student) => (
              <option value={student.studentId} key={student.studentId}>
                {student.name} ({student.studentId})
              </option>
            ))}
          </select>
        </div>

        {!selectedStudent ? <p className="muted">Pick a student to inspect location history.</p> : null}

        {selectedStudent ? (
          <div className="trail-list">
            {selectedStudent.locationHistory?.length ? (
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
            ) : (
              <p className="muted">No trail data available.</p>
            )}
          </div>
        ) : null}
      </main>
    </div>
  );
}
