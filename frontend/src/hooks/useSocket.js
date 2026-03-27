import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { io } from "socket.io-client";

const API_BASE =
  import.meta.env.VITE_BACKEND_URL ||
  import.meta.env.VITE_API_BASE ||
  "http://localhost:5000";

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
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const socketRef = useRef(null);

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
      const withId = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        ...event,
      };
      setEvents((prev) => [withId, ...prev].slice(0, 200));
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [fetchStudents]);

  const sortedStudents = useMemo(() => {
    return [...students].sort((a, b) => a.name.localeCompare(b.name));
  }, [students]);

  return {
    students: sortedStudents,
    events,
    connected,
    error,
    refreshStudents: fetchStudents,
  };
}
