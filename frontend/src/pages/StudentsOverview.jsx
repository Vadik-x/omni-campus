import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import useSocket from "../hooks/useSocket";

function safeDate(value) {
  const parsed = value ? new Date(value) : new Date();
  if (Number.isNaN(parsed.getTime())) {
    return new Date();
  }
  return parsed;
}

function dayKey(value) {
  const date = safeDate(value);
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy.toISOString().slice(0, 10);
}

function prettyDay(value) {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatDateTime(value) {
  return safeDate(value).toLocaleString();
}

export default function StudentsOverview() {
  const { students } = useSocket();
  const navigate = useNavigate();

  const todayKey = useMemo(() => dayKey(new Date()), []);

  const metrics = useMemo(() => {
    const total = students.length;
    const addedToday = students.filter((student) => dayKey(student.createdAt) === todayKey).length;
    const activeNow = students.filter((student) => String(student.status || "").toLowerCase() === "online").length;
    const onCampus = students.filter((student) => Boolean(student.isOnCampus)).length;

    return {
      total,
      addedToday,
      activeNow,
      onCampus,
    };
  }, [students, todayKey]);

  const weeklyTrend = useMemo(() => {
    const today = safeDate(new Date());
    today.setHours(0, 0, 0, 0);

    const buckets = [];
    const counts = new Map();

    for (let offset = 6; offset >= 0; offset -= 1) {
      const day = new Date(today);
      day.setDate(today.getDate() - offset);
      const key = day.toISOString().slice(0, 10);
      buckets.push(key);
      counts.set(key, 0);
    }

    students.forEach((student) => {
      const key = dayKey(student.createdAt);
      if (counts.has(key)) {
        counts.set(key, Number(counts.get(key) || 0) + 1);
      }
    });

    const series = buckets.map((key) => ({
      key,
      label: prettyDay(key),
      count: Number(counts.get(key) || 0),
    }));

    const maxCount = Math.max(1, ...series.map((item) => item.count));
    return {
      series,
      maxCount,
      weekTotal: series.reduce((sum, item) => sum + item.count, 0),
    };
  }, [students]);

  const recentlyAdded = useMemo(() => {
    return [...students]
      .sort((a, b) => safeDate(b.createdAt).getTime() - safeDate(a.createdAt).getTime())
      .slice(0, 12);
  }, [students]);

  return (
    <div className="dashboard-page students-overview-page">
      <div className="scene-backdrop" aria-hidden="true">
        <span className="scene-orb scene-orb-a" />
        <span className="scene-orb scene-orb-b" />
        <span className="scene-grid-tilt" />
      </div>

      <header className="stats-bar panel">
        <h1>Student Registry Insight</h1>
        <div className="top-links">
          <Link to="/">Dashboard</Link>
          <Link to="/search">Search</Link>
          <Link to="/trail">Trail</Link>
        </div>
      </header>

      <main className="panel route-page students-overview-shell">
        <section className="overview-kpis">
          <article className="overview-kpi">
            <span>Total Students</span>
            <strong>{metrics.total}</strong>
          </article>
          <article className="overview-kpi">
            <span>Added Today</span>
            <strong>{metrics.addedToday}</strong>
          </article>
          <article className="overview-kpi">
            <span>Online Now</span>
            <strong>{metrics.activeNow}</strong>
          </article>
          <article className="overview-kpi">
            <span>On Campus</span>
            <strong>{metrics.onCampus}</strong>
          </article>
        </section>

        <section className="overview-grid">
          <article className="overview-card overview-chart">
            <div className="overview-card-head">
              <h3>Students Added In Last 7 Days</h3>
              <span>{weeklyTrend.weekTotal} new this week</span>
            </div>
            <div className="trend-bars" role="list" aria-label="Students added per day">
              {weeklyTrend.series.map((point) => (
                <div className="trend-bar-row" key={point.key} role="listitem">
                  <span className="trend-day">{point.label}</span>
                  <div className="trend-bar-shell">
                    <div
                      className="trend-bar"
                      style={{
                        width: `${(point.count / weeklyTrend.maxCount) * 100}%`,
                      }}
                    />
                  </div>
                  <strong className="trend-count">{point.count}</strong>
                </div>
              ))}
            </div>
          </article>

          <article className="overview-card overview-list">
            <div className="overview-card-head">
              <h3>Recently Added Students</h3>
              <span>Click any row for full profile</span>
            </div>

            <div className="overview-student-list">
              {recentlyAdded.length === 0 ? <p className="muted">No students added yet.</p> : null}
              {recentlyAdded.map((student) => (
                <button
                  type="button"
                  className="overview-student-item"
                  key={student.studentId}
                  onClick={() => navigate(`/students/${encodeURIComponent(student.studentId)}`)}
                >
                  <div>
                    <strong>{student.name}</strong>
                    <p>
                      {student.program || "Program not set"} | {student.studentId}
                    </p>
                  </div>
                  <small>{formatDateTime(student.createdAt)}</small>
                </button>
              ))}
            </div>
          </article>
        </section>
      </main>
    </div>
  );
}
