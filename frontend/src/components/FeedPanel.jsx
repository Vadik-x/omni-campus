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

function confidenceToPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  const asPercent = numeric <= 1 ? numeric * 100 : numeric;
  return Math.max(0, Math.min(100, Math.round(asPercent)));
}

function formatEventLine(event = {}) {
  const studentName = String(event.studentName || "Unknown student");
  const cameraLabel =
    String(event.cameraLabel || event.location || "").trim() || "Unknown camera";
  const confidencePct = Number.isFinite(Number(event.confidencePct))
    ? Number(event.confidencePct)
    : confidenceToPercent(event.confidence);
  const eventDate = event.timestamp ? new Date(event.timestamp) : new Date();
  const safeDate = Number.isNaN(eventDate.getTime()) ? new Date() : eventDate;
  const time = safeDate.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  return `${studentName} • ${cameraLabel} • ${confidencePct}% • ${time}`;
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
            <p className="feed-line">{event.feedText || formatEventLine(event)}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
