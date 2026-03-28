import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { io } from "socket.io-client";

const API_BASE =
  import.meta.env.VITE_BACKEND_URL ||
  import.meta.env.VITE_API_BASE ||
  "http://localhost:5000";
const FEED_EVENT_DEDUPE_MS = 8000;

function upsertStudent(list, incoming) {
  const idx = list.findIndex((s) => s.studentId === incoming.studentId);
  if (idx === -1) {
    return [incoming, ...list];
  }

  const next = [...list];
  next[idx] = incoming;
  return next;
}

export default function useSocket() {
  const [students, setStudents] = useState([]);
  const [events, setEvents] = useState([]);
  const [cameras, setCameras] = useState([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const socketRef = useRef(null);
  const lastDetectionTimeRef = useRef(new Map());

  const addLocalEvent = useCallback((event) => {
    const withId = {
      id: event.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      ...event,
    };

    const studentId = String(withId.studentId || "").trim();
    const eventTime = Date.parse(withId.timestamp || "");
    const now = Number.isFinite(eventTime) ? eventTime : Date.now();
    if (studentId) {
      const last = lastDetectionTimeRef.current.get(studentId) || 0;
      if (now - last <= FEED_EVENT_DEDUPE_MS) {
        return;
      }
      lastDetectionTimeRef.current.set(studentId, now);
    }

    setEvents((prev) => {
      const duplicate = prev.some(
        (item) =>
          item.timestamp === withId.timestamp &&
          item.method === withId.method &&
          item.studentName === withId.studentName &&
          (item.cameraId || item.cameraLabel || item.location) ===
            (withId.cameraId || withId.cameraLabel || withId.location)
      );

      if (duplicate) {
        return prev;
      }

      return [withId, ...prev].slice(0, 300);
    });
  }, []);

  const emitEvent = useCallback((event, payload) => {
    if (!socketRef.current) {
      return;
    }

    socketRef.current.emit(event, payload);
  }, []);

  const fetchStudents = useCallback(async () => {
    try {
      const response = await axios.get(`${API_BASE}/api/students`);
      setStudents(response.data || []);
      setError("");
    } catch (error) {
      console.error("Failed to fetch students:", error.message);
      setError(`Cannot load students from ${API_BASE}`);
    }
  }, []);

  useEffect(() => {
    fetchStudents();

    const socket = io(API_BASE, {
      transports: ["websocket"],
      reconnection: true,
    });

    socketRef.current = socket;

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));

    socket.on("student:update", (student) => {
      if (!student || !student.studentId) {
        return;
      }

      setStudents((prev) => upsertStudent(prev, student));
    });

    socket.on("detection:event", (event) => {
      addLocalEvent(event);
    });

    socket.on("cameras:list", (list) => {
      setCameras(Array.isArray(list) ? list : []);
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [addLocalEvent, fetchStudents]);

  const sortedStudents = useMemo(() => {
    return [...students].sort((a, b) => a.name.localeCompare(b.name));
  }, [students]);

  return {
    students: sortedStudents,
    events,
    cameras,
    connected,
    error,
    emitEvent,
    addLocalEvent,
    refreshStudents: fetchStudents,
  };
}
