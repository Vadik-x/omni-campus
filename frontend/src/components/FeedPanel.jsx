function tone(method = "") {
  const upper = method.toUpperCase();
  if (upper.includes("FACE")) {
    return "camera";
  }
  if (upper.includes("CAMERA")) {
    return "camera";
  }
  if (upper.includes("WIFI") || upper.includes("RF")) {
    return "wifi";
  }
  if (upper.includes("SYSTEM")) {
    return "system";
  }
  return "default";
}

export default function FeedPanel({ events, onEventClick, selectedStudentId = "" }) {
  return (
    <section className="panel feed-panel">
      <h3>Live Activity Feed</h3>
      <div className="feed-list">
        {events.length === 0 ? <p className="muted">Waiting for detections...</p> : null}
        {events.map((event) => (
          <div
            role="button"
            tabIndex={0}
            className={`feed-item feed-item-btn ${tone(event.method)} ${
              selectedStudentId && event.studentId === selectedStudentId ? "active" : ""
            }`}
            key={event.id}
            onClick={() => onEventClick?.(event)}
            onKeyDown={(keyboardEvent) => {
              if (keyboardEvent.key === "Enter" || keyboardEvent.key === " ") {
                keyboardEvent.preventDefault();
                onEventClick?.(event);
              }
            }}
          >
            <div className="feed-top">
              <strong>{event.studentName || "Unknown student"}</strong>
              <span>{new Date(event.timestamp || Date.now()).toLocaleTimeString()}</span>
            </div>
            <p>{event.location || event.cameraLabel || "Unknown location"}</p>
            <small>
              Method: {event.method || "N/A"} | Confidence: {event.confidence ?? 0}
            </small>
          </div>
        ))}
      </div>
    </section>
  );
}
