function tone(method = "") {
  const upper = method.toUpperCase();
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

export default function FeedPanel({ events }) {
  return (
    <section className="panel feed-panel">
      <h3>Live Activity Feed</h3>
      <div className="feed-list">
        {events.length === 0 ? <p className="muted">Waiting for live events...</p> : null}
        {events.map((event) => (
          <article className={`feed-item ${tone(event.method)}`} key={event.id}>
            <div className="feed-top">
              <strong>{event.studentName || "Unknown student"}</strong>
              <span>{new Date(event.timestamp || Date.now()).toLocaleTimeString()}</span>
            </div>
            <p>{event.location || "Unknown location"}</p>
            <small>
              Method: {event.method || "N/A"} | Confidence: {event.confidence ?? 0}
            </small>
          </article>
        ))}
      </div>
    </section>
  );
}
