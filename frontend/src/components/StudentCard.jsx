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

export default function StudentCard({ student, selected, onSelect, cardRef, onDelete }) {
  return (
    <article
      className={`student-card-shell ${selected ? "selected" : ""}`}
      id={`student-card-${student.studentId}`}
      data-student-id={student.studentId}
      ref={cardRef}
    >
      <button
        type="button"
        className={`student-card ${selected ? "selected" : ""}`}
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
            {student.currentLocation?.buildingName || "Unknown"} | Last seen:{" "}
            {formatDateTime(student.currentLocation?.lastSeen)}
          </p>
        </div>
      </button>

      {typeof onDelete === "function" ? (
        <button
          type="button"
          className="student-delete-btn"
          aria-label={`Delete ${student.name}`}
          title={`Delete ${student.name}`}
          onClick={(event) => {
            event.stopPropagation();
            onDelete(student);
          }}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path
              d="M9 3h6l1 2h4v2H4V5h4l1-2zm1 6h2v9h-2V9zm4 0h2v9h-2V9zM6 9h2v9H6V9z"
              fill="currentColor"
            />
          </svg>
        </button>
      ) : null}
    </article>
  );
}
