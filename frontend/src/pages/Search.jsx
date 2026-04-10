import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import useSocket from "../hooks/useSocket";
import StudentCard from "../components/StudentCard";

export default function Search() {
  const { students } = useSocket();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState("");
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

  return (
    <div className="dashboard-page">
      <div className="scene-backdrop" aria-hidden="true">
        <span className="scene-orb scene-orb-a" />
        <span className="scene-orb scene-orb-b" />
        <span className="scene-grid-tilt" />
      </div>

      <header className="stats-bar panel">
        <h1>Student Search</h1>
        <div className="top-links">
          <Link to="/">Dashboard</Link>
          <Link to="/students">Students Added</Link>
          <Link to="/trail">Trail</Link>
        </div>
      </header>

      <main className="panel route-page">
        <div className="left-header">
          <h3>Find Student</h3>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Type name, ID, or program"
          />
        </div>

        <div className="student-list">
          {filteredStudents.map((student) => (
            <StudentCard
              key={student.studentId}
              student={student}
              selected={selectedId === student.studentId}
              onSelect={setSelectedId}
              onOpenDetail={(entry) =>
                navigate(`/students/${encodeURIComponent(entry.studentId)}`)
              }
            />
          ))}
          {filteredStudents.length === 0 ? <p className="muted">No matching students</p> : null}
        </div>
      </main>
    </div>
  );
}
