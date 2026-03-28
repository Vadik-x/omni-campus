import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { io } from "socket.io-client";

const API_BASE =
  import.meta.env.VITE_BACKEND_URL ||
  import.meta.env.VITE_API_BASE ||
  "http://localhost:5000";
const FEED_ENTRY_GAP_MS = 15000;
const FEED_MAX_ENTRIES = 50;
const FEED_MAX_PER_STUDENT = 3;

function normalizeFeedKey(event = {}) {
  const studentId = String(event.studentId || "").trim();
  if (studentId) {
    return studentId;
  }

  const studentName = String(event.studentName || "").trim().toLowerCase();
  return studentName || "";
}

function confidenceToPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  const asPercent = numeric <= 1 ? numeric * 100 : numeric;
  return Math.max(0, Math.min(100, Math.round(asPercent)));
}

function formatFeedTime(value) {
  const parsed = value ? new Date(value) : new Date();
  const safe = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  return safe.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function buildFeedText({ studentName, cameraLabel, confidencePct, timestamp }) {
  return `${studentName} • ${cameraLabel} • ${confidencePct}% • ${formatFeedTime(timestamp)}`;
}

function trimFeedEntries(entries = []) {
  const perStudentCounts = new Map();
  const trimmed = [];

  for (const item of entries) {
    const key = normalizeFeedKey(item);
    if (key) {
      const seen = Number(perStudentCounts.get(key) || 0);
      if (seen >= FEED_MAX_PER_STUDENT) {
        continue;
      }
      perStudentCounts.set(key, seen + 1);
    }

    trimmed.push(item);
    if (trimmed.length >= FEED_MAX_ENTRIES) {
      break;
    }
  }

  return trimmed;
}

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
  const lastFeedEntryRef = useRef(new Map());

  const removeStudentLocally = useCallback((studentId) => {
    const key = String(studentId || "").trim();
    if (!key) {
      return;
    }

    setStudents((prev) =>
      prev.filter((item) => {
        const nextStudentId = String(item.studentId || "").trim();
        const nextInternalId = String(item._id || "").trim();
        return nextStudentId !== key && nextInternalId !== key;
      })
    );
    setEvents((prev) => prev.filter((item) => String(item.studentId || "") !== key));
    lastFeedEntryRef.current.delete(key);
  }, []);

  const addLocalEvent = useCallback((event) => {
    const studentId = String(event?.studentId || "").trim();
    const studentName = String(event?.studentName || "").trim() || "Unknown";
    const eventTime = Date.parse(event?.timestamp || "");
    const now = Number.isFinite(eventTime) ? eventTime : Date.now();
    const timestamp = new Date(now).toISOString();
    const cameraLabel =
      String(event?.cameraLabel || event?.location || "").trim() || "Unknown Camera";
    const confidencePct = confidenceToPercent(event?.confidence);
    const feedKey = normalizeFeedKey({ studentId, studentName });

    if (feedKey) {
      const last = Number(lastFeedEntryRef.current.get(feedKey) || 0);
      if (now - last <= FEED_ENTRY_GAP_MS) {
        return;
      }
      lastFeedEntryRef.current.set(feedKey, now);
    }

    const withId = {
      id: event.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      ...event,
      studentId,
      studentName,
      cameraLabel,
      location: cameraLabel,
      timestamp,
      confidence: Number((confidencePct / 100).toFixed(3)),
      confidencePct,
      feedText: buildFeedText({
        studentName,
        cameraLabel,
        confidencePct,
        timestamp,
      }),
    };

    setEvents((prev) => {
      const duplicate = prev.some(
        (item) =>
          item.timestamp === withId.timestamp &&
          String(item.studentId || "") === withId.studentId &&
          String(item.cameraLabel || item.location || "") === withId.cameraLabel
      );

      if (duplicate) {
        return prev;
      }

      return trimFeedEntries([withId, ...prev]);
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

  const deleteStudent = useCallback(
    async (studentId) => {
      const key = String(studentId || "").trim();
      if (!key) {
        throw new Error("Student ID is required");
      }

      const response = await axios.delete(`${API_BASE}/api/students/${encodeURIComponent(key)}`);
      removeStudentLocally(key);
      return response.data?.student || null;
    },
    [removeStudentLocally]
  );

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

    socket.on("student:delete", (payload = {}) => {
      removeStudentLocally(payload.studentId);
    });

    socket.on("student:removed", ({ studentId } = {}) => {
      removeStudentLocally(studentId);
    });

    socket.on("students:cleared", () => {
      setStudents([]);
      setEvents([]);
      lastFeedEntryRef.current.clear();
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
  }, [addLocalEvent, fetchStudents, removeStudentLocally]);

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
    deleteStudent,
    refreshStudents: fetchStudents,
  };
}
