import { useEffect, useState } from "react";
import { io } from "socket.io-client";

const API_BASE =
  import.meta.env.VITE_BACKEND_URL ||
  import.meta.env.VITE_API_BASE ||
  "http://localhost:5000";

function formatTime(value) {
  if (!value) {
    return "Waiting for stream...";
  }

  return new Date(value).toLocaleTimeString();
}

export default function VideoFeed() {
  const [frame, setFrame] = useState("");
  const [meta, setMeta] = useState({
    connected: false,
    mode: "mock",
    timestamp: null,
  });

  useEffect(() => {
    const socket = io(API_BASE, {
      transports: ["websocket"],
      reconnection: true,
    });

    socket.on("camera-frame", (payload) => {
      if (!payload || !payload.frame) {
        return;
      }

      setFrame(payload.frame);
      setMeta({
        connected: Boolean(payload.connected),
        mode: payload.mode || "mock",
        timestamp: payload.timestamp || null,
      });
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, []);

  return (
    <section className="panel video-feed-panel">
      <div className="video-head">
        <h3>Live Camera Feed</h3>
        <span className={`status-badge ${meta?.mode === "live" ? "online" : "offline"}`}>
          {meta?.mode === "live" ? "Live" : "Mock"}
        </span>
      </div>

      <div className="video-canvas-wrap">
        {frame ? (
          <img className="video-canvas" src={frame} alt="Campus camera frame" />
        ) : (
          <div className="video-placeholder">Camera frame not available</div>
        )}
      </div>

      <p className="muted">
        Source: {meta?.connected ? "System webcam (index 0)" : "Mock fallback"} | Updated: {formatTime(meta?.timestamp)}
      </p>
    </section>
  );
}
