import { AnimatePresence, motion } from "framer-motion";

function tone(method = "") {
  const upper = method.toUpperCase();
  if (upper.includes("FACE")) {
    return "success";
  }
  if (upper.includes("CAMERA")) {
    return "success";
  }
  if (upper.includes("WIFI") || upper.includes("RF")) {
    return "warning";
  }
  if (upper.includes("SYSTEM")) {
    return "alert";
  }
  return "warning";
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

export default function FeedPanel({
  events,
  onEventClick,
  selectedStudentId = "",
  loading = false,
}) {
  return (
    <motion.section
      initial={{ opacity: 0, x: 14 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.34, ease: "easeOut" }}
      className="glass-card flex min-h-[240px] flex-col p-4"
    >
      <div className="mb-3 flex items-center justify-between">
        <h3 className="panel-title">Live Activity Feed</h3>
        <span className="rounded-full bg-cyan-500/15 px-2 py-1 text-[11px] font-semibold uppercase tracking-widest text-cyan-200">
          Realtime
        </span>
      </div>

      <div className="space-y-2">
        {loading ? (
          <div className="space-y-2" aria-hidden="true">
            {Array.from({ length: 6 }).map((_, index) => (
              <div
                key={`feed-skeleton-${index}`}
                className="skeleton-block relative h-[68px] overflow-hidden rounded-xl border border-white/10 bg-white/[0.05]"
              >
                <span className="skeleton-shimmer absolute inset-0" />
              </div>
            ))}
          </div>
        ) : null}

        {events.length === 0 ? (
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-sm text-slate-300">
            Waiting for detections...
          </div>
        ) : null}

        <AnimatePresence initial={false} mode="popLayout">
          {!loading
            ? events.map((event) => {
                const level = tone(event.method);
                const toneClass =
                  level === "alert"
                    ? "log-alert"
                    : level === "warning"
                      ? "log-warning"
                      : "log-success";

                const highlighted = selectedStudentId && event.studentId === selectedStudentId;
                const timestamp = event.timestamp
                  ? new Date(event.timestamp).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })
                  : "--:--:--";

                return (
                  <motion.div
                    layout
                    initial={{ opacity: 0, y: 10, scale: 0.99 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -8, scale: 0.99 }}
                    transition={{ duration: 0.22, ease: "easeOut" }}
                    role="button"
                    tabIndex={0}
                    className={`${toneClass} cursor-pointer rounded-xl border border-white/10 px-3 py-2 transition-all duration-300 hover:-translate-y-0.5 hover:border-cyan-300/40 hover:shadow-neon-soft ${
                      highlighted ? "border-cyan-300/60 ring-1 ring-cyan-300/40" : ""
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
                    <p className="text-sm font-medium leading-snug text-slate-100">{event.feedText || formatEventLine(event)}</p>
                    <p className="mt-1 text-[11px] uppercase tracking-widest text-slate-300/80">{timestamp}</p>
                  </motion.div>
                );
              })
            : null}
        </AnimatePresence>
      </div>
    </motion.section>
  );
}
