function getInitials(name = "") {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function formatDateTime(input) {
  if (!input) {
    return "Never";
  }

  return new Date(input).toLocaleString();
}

export default function StudentCard({ student, selected, onSelect, cardRef }) {
  return (
    <button
      type="button"
      className={`student-card ${selected ? "selected" : ""}`}
      id={`student-card-${student.studentId}`}
      data-student-id={student.studentId}
      ref={cardRef}
      onClick={() => onSelect(student.studentId)}
    >
      <div className="avatar">{getInitials(student.name)}</div>
      <div className="student-info">
        <div className="student-header">
          <strong>{student.name}</strong>
          <span className={`status-badge ${student.status || "offline"}`}>
            {student.status || "offline"}
          </span>
        </div>
        <p>{student.program}</p>
        <p>{student.studentId}</p>
        <p>
          {student.currentLocation?.buildingName || "Unknown"} | Last seen: {" "}
          {formatDateTime(student.currentLocation?.lastSeen)}
        </p>
      </div>
    </button>
  );
}
