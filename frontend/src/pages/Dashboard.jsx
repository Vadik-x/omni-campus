import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import useSocket from "../hooks/useSocket";
import { getFaceEngine } from "../lib/faceEngineLoader";
import { createSignedSocketPayload } from "../lib/securityHeaders";
import {
  pageVariants,
  panelVariants,
  staggerContainerVariants,
  staggerItemVariants,
  toastVariants,
} from "../lib/motionPresets";
import DashboardSkeleton from "../components/DashboardSkeleton";
import KpiCard from "../components/KpiCard";
import RegisterFaceBoundary from "../components/RegisterFaceBoundary";
import {
  AlertsIcon,
  CamerasIcon,
  PresenceIcon,
  SocketIcon,
} from "../components/icons/KpiIcons";

const CampusMap = lazy(() => import("../components/CampusMap"));
const FeedPanel = lazy(() => import("../components/FeedPanel"));
const RecognitionMetricsPanel = lazy(() => import("../components/RecognitionMetricsPanel"));
const CameraGrid = lazy(() => import("../components/CameraGrid"));
const FaceRegister = lazy(() => import("../components/FaceRegister"));

const CAMERA_POSITIONS_STORAGE_KEY = "cameraPositions";
const LEGACY_CAMERA_LOCATION_STORAGE_KEY = "omni:cameraLocations:v1";
const CAMPUS_CENTER_STORAGE_KEY = "campusCenter";
const REGISTRY_STORAGE_KEY = "omni:registry:v2";
const LEGACY_REGISTRY_STORAGE_KEY = "omni:faces:v1";
const ENGINE_FACE_STORAGE_KEY = "omni_face_registry";
const DETECTION_PROFILE_STORAGE_KEY = "omni:detectionProfile:v1";
const DEFAULT_CAMPUS_CENTER = [28.6967, 77.4988];
const MAP_ZOOM_LEVEL = 15;
const CAMERA_POSITION_OFFSETS = [
  [0.00028, -0.00022],
  [-0.0002, 0.00024],
  [0.00018, 0.0003],
  [-0.00032, -0.00015],
  [0.00035, 0.00005],
];

function normalizePoint(value, fallback = DEFAULT_CAMPUS_CENTER) {
  if (Array.isArray(value) && value.length >= 2) {
    const lat = Number(value[0]);
    const lng = Number(value[1]);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return [lat, lng];
    }
  }

  if (value && typeof value === "object") {
    const lat = Number(value.lat);
    const lng = Number(value.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return [lat, lng];
    }
  }

  return [fallback[0], fallback[1]];
}

function pointsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length < 2 || b.length < 2) {
    return false;
  }

  return Number(a[0]) === Number(b[0]) && Number(a[1]) === Number(b[1]);
}

function loadStoredCameraLocations() {
  const keys = [CAMERA_POSITIONS_STORAGE_KEY, LEGACY_CAMERA_LOCATION_STORAGE_KEY];

  try {
    for (const key of keys) {
      const raw = localStorage.getItem(key);
      if (!raw) {
        continue;
      }

      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }

      const normalized = {};
      Object.entries(parsed).forEach(([cameraKey, point]) => {
        normalized[cameraKey] = normalizePoint(point, DEFAULT_CAMPUS_CENTER);
      });

      return normalized;
    }
  } catch (error) {
    return {};
  }

  return {};
}

function loadStoredCampusCenter() {
  try {
    const raw = localStorage.getItem(CAMPUS_CENTER_STORAGE_KEY);
    if (!raw) {
      return [...DEFAULT_CAMPUS_CENTER];
    }

    const parsed = JSON.parse(raw);
    return normalizePoint(parsed, DEFAULT_CAMPUS_CENTER);
  } catch (error) {
    return [...DEFAULT_CAMPUS_CENTER];
  }
}

function defaultCameraPosition(index, center = DEFAULT_CAMPUS_CENTER) {
  const [offsetLat, offsetLng] = CAMERA_POSITION_OFFSETS[index % CAMERA_POSITION_OFFSETS.length];

  return [
    Number((center[0] + offsetLat).toFixed(6)),
    Number((center[1] + offsetLng).toFixed(6)),
  ];
}

function removeStudentFromLocalRegistries(studentId) {
  const key = String(studentId || "").trim();
  if (!key || typeof window === "undefined") {
    return;
  }

  try {
    const raw = localStorage.getItem(REGISTRY_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const next = parsed.filter((entry) => String(entry?.studentId || "") !== key);
        localStorage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify(next));
      }
    }
  } catch (error) {
    // Ignore storage parse errors so delete flow is not blocked.
  }

  try {
    const legacyRaw = localStorage.getItem(LEGACY_REGISTRY_STORAGE_KEY);
    if (legacyRaw) {
      const parsed = JSON.parse(legacyRaw);
      if (Array.isArray(parsed)) {
        const next = parsed.filter((entry) => String(entry?.personId || "") !== key);
        localStorage.setItem(LEGACY_REGISTRY_STORAGE_KEY, JSON.stringify(next));
      }
    }
  } catch (error) {
    // Ignore storage parse errors so delete flow is not blocked.
  }

  try {
    const engineRaw = localStorage.getItem(ENGINE_FACE_STORAGE_KEY);
    if (engineRaw) {
      const parsed = JSON.parse(engineRaw);
      if (Array.isArray(parsed)) {
        const next = parsed.filter((entry) => String(entry?.personId || "") !== key);
        localStorage.setItem(ENGINE_FACE_STORAGE_KEY, JSON.stringify(next));
      }
    }
  } catch (error) {
    // Ignore storage parse errors so delete flow is not blocked.
  }
}

function getInitials(name = "") {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function formatDateTime(value) {
  if (!value) {
    return "Never";
  }
  return new Date(value).toLocaleString();
}

function loadStoredDetectionProfile() {
  try {
    const stored = String(localStorage.getItem(DETECTION_PROFILE_STORAGE_KEY) || "").trim();
    if (stored === "precision" || stored === "ultra-fast") {
      return stored;
    }
  } catch (error) {
    return "ultra-fast";
  }

  return "ultra-fast";
}

export default function Dashboard() {
  const {
    students,
    events,
    cameras,
    connected,
    error,
    isBootstrapping,
    emitEvent,
    addLocalEvent,
    deleteStudent,
    refreshStudents,
  } = useSocket();

  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [showRegisterFace, setShowRegisterFace] = useState(false);
  const [detectionProfile, setDetectionProfile] = useState(() => loadStoredDetectionProfile());
  const [cameraGridExpanded, setCameraGridExpanded] = useState(true);
  const [campusCenter, setCampusCenter] = useState(() => loadStoredCampusCenter());
  const [cameraLocations, setCameraLocations] = useState(() => loadStoredCameraLocations());
  const [toastMessage, setToastMessage] = useState("");
  const [studentsCollapsed, setStudentsCollapsed] = useState(false);

  const knownStudentIds = useMemo(() => {
    return Array.from(
      new Set(
        (students || [])
          .map((student) => String(student?.studentId || "").trim())
          .filter(Boolean)
      )
    ).sort();
  }, [students]);

  const studentCardRefs = useRef(new Map());
  const navigate = useNavigate();

  useEffect(() => {
    if (!toastMessage) {
      return undefined;
    }

    const timer = setTimeout(() => {
      setToastMessage("");
    }, 2600);

    return () => clearTimeout(timer);
  }, [toastMessage]);

  useEffect(() => {
    const timer = setTimeout(() => {
      window.dispatchEvent(new Event("resize"));
    }, 500);

    return () => clearTimeout(timer);
  }, [cameraGridExpanded]);

  useEffect(() => {
    if (isBootstrapping || error) {
      return;
    }

    let cancelled = false;
    let timeoutId = null;
    let idleId = null;

    const prewarmFaceEngine = async () => {
      try {
        const faceEngine = await getFaceEngine();
        await faceEngine.loadModels();
      } catch (error) {
        // Ignore prewarm failures; registration flow will retry on demand.
      }
    };

    if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
      idleId = window.requestIdleCallback(() => {
        if (!cancelled) {
          void prewarmFaceEngine();
        }
      }, { timeout: 5000 });
    } else {
      timeoutId = window.setTimeout(() => {
        if (!cancelled) {
          void prewarmFaceEngine();
        }
      }, 1200);
    }

    return () => {
      cancelled = true;
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
      if (
        idleId
        && typeof window !== "undefined"
        && typeof window.cancelIdleCallback === "function"
      ) {
        window.cancelIdleCallback(idleId);
      }
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(CAMERA_POSITIONS_STORAGE_KEY, JSON.stringify(cameraLocations));
    localStorage.setItem(LEGACY_CAMERA_LOCATION_STORAGE_KEY, JSON.stringify(cameraLocations));
  }, [cameraLocations]);

  useEffect(() => {
    localStorage.setItem(
      CAMPUS_CENTER_STORAGE_KEY,
      JSON.stringify({ lat: campusCenter[0], lng: campusCenter[1] })
    );
  }, [campusCenter]);

  useEffect(() => {
    localStorage.setItem(DETECTION_PROFILE_STORAGE_KEY, detectionProfile);
  }, [detectionProfile]);

  useEffect(() => {
    let cancelled = false;

    const syncFaceEngineWithBackendStudents = async () => {
      try {
        const faceEngine = await getFaceEngine();
        if (cancelled) {
          return;
        }

        const knownStudentIdsSet = new Set(knownStudentIds);

        const localPeople = Array.isArray(faceEngine.getAllPeople?.())
          ? faceEngine.getAllPeople()
          : [];

        localPeople.forEach((person) => {
          const personId = String(person?.personId || "").trim();
          if (!personId) {
            return;
          }

          if (!knownStudentIdsSet.has(personId)) {
            faceEngine.clearPerson(personId);
          }
        });
      } catch (error) {
        // Ignore sync failures; realtime detection continues with current cache.
      }
    };

    void syncFaceEngineWithBackendStudents();

    return () => {
      cancelled = true;
    };
  }, [error, isBootstrapping, knownStudentIds]);

  useEffect(() => {
    setCameraLocations((prev) => {
      const next = { ...prev };
      let changed = false;

      cameras.forEach((camera, index) => {
        const cameraId = String(camera.cameraId || `camera-${index + 1}`);
        const cameraLabel = String(camera.cameraLabel || `Camera ${index + 1}`);
        const existing = next[cameraId] || next[cameraLabel];

        if (existing) {
          const normalized = normalizePoint(existing, defaultCameraPosition(index, campusCenter));
          if (!next[cameraId]) {
            next[cameraId] = normalized;
            changed = true;
          } else if (!pointsEqual(next[cameraId], normalized)) {
            next[cameraId] = normalized;
            changed = true;
          }

          if (!next[cameraLabel]) {
            next[cameraLabel] = normalized;
            changed = true;
          } else if (!pointsEqual(next[cameraLabel], normalized)) {
            next[cameraLabel] = normalized;
            changed = true;
          }

          return;
        }

        const fallback = defaultCameraPosition(index, campusCenter);
        next[cameraId] = fallback;
        next[cameraLabel] = fallback;
        changed = true;
      });

      return changed ? next : prev;
    });
  }, [campusCenter, cameras]);

  const handleCampusCenterChange = useCallback((nextCenter) => {
    const normalized = normalizePoint(nextCenter, DEFAULT_CAMPUS_CENTER);
    setCampusCenter(normalized);

    if (typeof window !== "undefined") {
      localStorage.setItem(
        CAMPUS_CENTER_STORAGE_KEY,
        JSON.stringify({ lat: normalized[0], lng: normalized[1] })
      );
    }
  }, []);

  const handleCameraPositionChange = useCallback(
    ({ cameraId, cameraLabel, position }) => {
      const normalized = normalizePoint(position, campusCenter);

      setCameraLocations((prev) => {
        const next = { ...prev };
        let changed = false;

        if (cameraId) {
          const key = String(cameraId);
          if (!pointsEqual(next[key], normalized)) {
            next[key] = normalized;
            changed = true;
          }
        }

        if (cameraLabel) {
          const key = String(cameraLabel);
          if (!pointsEqual(next[key], normalized)) {
            next[key] = normalized;
            changed = true;
          }
        }

        return changed ? next : prev;
      });
    },
    [campusCenter]
  );

  const attachStudentCardRef = useCallback((studentId, node) => {
    const key = String(studentId || "");
    if (!key) {
      return;
    }

    if (!node) {
      studentCardRefs.current.delete(key);
      return;
    }

    studentCardRefs.current.set(key, node);
  }, []);

  const focusStudent = useCallback((studentId) => {
    setSelectedId(studentId);
  }, []);

  const openStudentDetail = useCallback(
    (studentOrId) => {
      const key =
        typeof studentOrId === "string"
          ? studentOrId
          : String(studentOrId?.studentId || "").trim();

      if (!key) {
        return;
      }

      navigate(`/students/${encodeURIComponent(key)}`);
    },
    [navigate]
  );

  const handleCameraExpandedChange = useCallback((expanded) => {
    setCameraGridExpanded(Boolean(expanded));
  }, []);

  const filteredStudents = useMemo(() => {
    const key = search.trim().toLowerCase();
    if (!key) {
      return students;
    }

    return students.filter((student) => {
      return [student.name, student.studentId, student.program]
        .join(" ")
        .toLowerCase()
        .includes(key);
    });
  }, [search, students]);

  const selectedStudent = useMemo(() => {
    return students.find((student) => student.studentId === selectedId) || null;
  }, [students, selectedId]);

  const stats = useMemo(() => {
    const onCampus = students.filter((s) => s.isOnCampus).length;
    const alert = students.filter((s) => s.status === "alert").length;
    const offline = students.filter((s) => s.status === "offline").length;
    return {
      onCampus,
      alert,
      offline,
    };
  }, [students]);

  const showSkeleton = isBootstrapping;

  const handleDetection = useCallback(
    (payload) => {
      const byId = students.find((student) => student.studentId === payload.studentId);
      const byName = students.find(
        (student) =>
          student.name?.trim().toLowerCase() ===
          String(payload.studentName || "").trim().toLowerCase()
      );

      const matched = byId || byName;
      if (!matched?.studentId) {
        const staleStudentId = String(payload?.studentId || "").trim();
        if (staleStudentId) {
          void (async () => {
            try {
              const faceEngine = await getFaceEngine();
              faceEngine.clearPerson(staleStudentId);
            } catch (faceError) {
              // Ignore local cache cleanup failures.
            }

            removeStudentFromLocalRegistries(staleStudentId);
          })();
        }

        void refreshStudents();
        return;
      }

      const event = {
        studentId: matched.studentId,
        studentName: matched.name || payload.studentName || "Unknown",
        cameraId: payload.cameraId,
        cameraLabel: payload.cameraLabel,
        location: payload.cameraLabel,
        method: "FACE-API",
        confidence: payload.confidence ?? 0,
        timestamp: payload.timestamp || new Date().toISOString(),
      };

      addLocalEvent(event);

      const socketPayload = {
        studentId: matched.studentId,
        studentName: matched.name || payload.studentName,
        cameraId: payload.cameraId,
        cameraLabel: payload.cameraLabel,
        confidence: payload.confidence,
        timestamp: event.timestamp,
      };

      void (async () => {
        try {
          const signedPayload = await createSignedSocketPayload(
            socketPayload,
            "socket.face:detected"
          );
          emitEvent("face:detected", signedPayload);
        } catch (signatureError) {
          emitEvent("face:detected", socketPayload);
        }
      })();

      focusStudent(matched.studentId);
    },
    [addLocalEvent, emitEvent, focusStudent, refreshStudents, students]
  );

  const handleDeleteStudent = useCallback(
    async (student) => {
      if (!student?.studentId) {
        return;
      }

      const confirmed = window.confirm(
        `Remove ${student.name} from system? This will delete all tracking data.`
      );
      if (!confirmed) {
        return;
      }

      try {
        await deleteStudent(student.studentId);

        try {
          const faceEngine = await getFaceEngine();
          faceEngine.clearPerson(student.studentId);
        } catch (faceError) {
          // Ignore lazy face engine load failures during deletion cleanup.
        }

        removeStudentFromLocalRegistries(student.studentId);

        if (selectedId === student.studentId) {
          setSelectedId("");
        }

        setToastMessage(`${student.name} removed from system`);
      } catch (deleteError) {
        setToastMessage(`Failed to remove ${student.name}`);
      }
    },
    [deleteStudent, selectedId]
  );

  const handleFeedEventClick = useCallback(
    (event) => {
      const eventStudentId = String(event?.studentId || "").trim();
      if (!eventStudentId) {
        return;
      }

      const matched = students.find((student) => String(student.studentId || "") === eventStudentId);
      if (!matched?.studentId) {
        return;
      }

      focusStudent(matched.studentId);
    },
    [focusStudent, students]
  );

  return (
    <MotionConfig reducedMotion="never">
      <div className="min-h-screen bg-[#0B0F14] font-sans text-slate-100">
        <div className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(circle_at_15%_8%,rgba(0,229,255,0.12),transparent_36%),radial-gradient(circle_at_82%_20%,rgba(59,130,246,0.16),transparent_34%),radial-gradient(circle_at_78%_84%,rgba(139,92,246,0.12),transparent_30%)]" />

        <div className="mx-auto flex w-full max-w-[1880px] flex-col gap-5 px-4 pb-10 pt-4 lg:px-6">
          <AnimatePresence mode="wait">
            {showSkeleton ? (
              <motion.div
                key="dashboard-loading"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
              >
                <DashboardSkeleton />
              </motion.div>
            ) : (
              <motion.div
                key="dashboard-ready"
                variants={pageVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
                className="space-y-5"
              >
                <motion.header
                  variants={panelVariants}
                  className="glass-card sticky top-3 z-50 rounded-2xl border border-white/10 px-5 py-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="space-y-1">
                      <h1 className="dashboard-title">Omni-Campus War Room</h1>
                      <p className="dashboard-kicker">AI-Driven Security Intelligence Command</p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <div className="space-y-1">
                        <div className="inline-flex items-center rounded-xl border border-white/15 bg-white/[0.04] p-1">
                          <button
                            type="button"
                            className={`rounded-lg px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] transition ${
                              detectionProfile === "precision"
                                ? "bg-cyan-500/20 text-cyan-100"
                                : "text-slate-300 hover:text-cyan-100"
                            }`}
                            onClick={() => setDetectionProfile("precision")}
                          >
                            Precision
                          </button>
                          <button
                            type="button"
                            className={`rounded-lg px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] transition ${
                              detectionProfile === "ultra-fast"
                                ? "bg-cyan-500/20 text-cyan-100"
                                : "text-slate-300 hover:text-cyan-100"
                            }`}
                            onClick={() => setDetectionProfile("ultra-fast")}
                          >
                            Ultra Fast
                          </button>
                          <button
                            type="button"
                            className={`rounded-lg px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] transition ${
                              detectionProfile === "extreme-demo"
                                ? "bg-amber-500/20 text-amber-100"
                                : "text-slate-300 hover:text-amber-100"
                            }`}
                            onClick={() => setDetectionProfile("extreme-demo")}
                          >
                            Extreme
                          </button>
                        </div>

                        {detectionProfile === "extreme-demo" ? (
                          <p className="text-[10px] uppercase tracking-[0.11em] text-amber-300">
                            Demo-only: lower precision and more false matches.
                          </p>
                        ) : null}
                      </div>

                      <div className="inline-flex items-center gap-2 rounded-full border border-emerald-300/35 bg-emerald-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-emerald-200">
                        <span className="h-2.5 w-2.5 rounded-full bg-emerald-300 shadow-[0_0_12px_rgba(74,222,128,0.95)] animate-pulse-dot" />
                        {connected ? "Live Link" : "Reconnecting"}
                      </div>

                      <motion.button
                        whileHover={{ y: -1 }}
                        whileTap={{ scale: 0.98 }}
                        type="button"
                        className="neon-btn"
                        onClick={() => setShowRegisterFace(true)}
                      >
                        Register Face
                      </motion.button>
                    </div>
                  </div>
                </motion.header>

                <motion.section
                  variants={staggerContainerVariants}
                  initial="hidden"
                  animate="visible"
                  className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4"
                >
                  <motion.div variants={staggerItemVariants}>
                    <KpiCard
                      icon={<CamerasIcon />}
                      label="Total Cameras"
                      value={cameras.length}
                      statusText={
                        cameras.length > 0
                          ? "Surveillance nodes online"
                          : "No camera source connected"
                      }
                      glow="cyan"
                      index={0}
                    />
                  </motion.div>
                  <motion.div variants={staggerItemVariants}>
                    <KpiCard
                      icon={<PresenceIcon />}
                      label="On Campus"
                      value={stats.onCampus}
                      statusText="Live student presence"
                      glow="blue"
                      index={1}
                    />
                  </motion.div>
                  <motion.div variants={staggerItemVariants}>
                    <KpiCard
                      icon={<AlertsIcon />}
                      label="Alerts"
                      value={stats.alert}
                      statusText={stats.alert > 0 ? "Attention required" : "No active alerts"}
                      glow="red"
                      index={2}
                    />
                  </motion.div>
                  <motion.div variants={staggerItemVariants}>
                    <KpiCard
                      icon={<SocketIcon connected={connected} />}
                      label="Socket Status"
                      value={connected ? "LIVE" : "SYNC"}
                      statusText={
                        connected ? "Realtime stream healthy" : "Attempting reconnection"
                      }
                      glow="violet"
                      index={3}
                    />
                  </motion.div>
                </motion.section>

              <motion.section variants={panelVariants} className="grid grid-cols-1 gap-4 xl:grid-cols-10">
                <motion.div variants={panelVariants} className="space-y-4 xl:col-span-7">
                  <section className="glass-card rounded-2xl border border-white/10 p-4">
                    {error ? (
                      <p className="mb-3 rounded-xl border border-red-300/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                        {error}
                      </p>
                    ) : null}

                    {showRegisterFace ? (
                      <div className="grid min-h-[300px] place-items-center rounded-xl border border-white/10 bg-white/[0.04] text-sm text-slate-300">
                        Camera feeds paused while Face Register is open.
                      </div>
                    ) : (
                      <Suspense
                        fallback={
                          <div className="grid min-h-[300px] place-items-center rounded-xl border border-white/10 bg-white/[0.04] text-sm text-slate-300">
                            Loading camera grid...
                          </div>
                        }
                      >
                        <CameraGrid
                          onDetection={handleDetection}
                          emitEvent={emitEvent}
                          socketConnected={connected}
                          onExpandedChange={handleCameraExpandedChange}
                          suspendProcessing={showRegisterFace}
                          detectionProfile={detectionProfile}
                        />
                      </Suspense>
                    )}
                  </section>

                  {showRegisterFace ? (
                    <div className="glass-card grid min-h-[420px] place-items-center rounded-2xl border border-white/10 text-sm text-slate-300">
                      Campus map paused while Face Register is open.
                    </div>
                  ) : (
                    <Suspense
                      fallback={
                        <div className="glass-card grid min-h-[420px] place-items-center rounded-2xl border border-white/10 text-sm text-slate-300">
                          Loading map...
                        </div>
                      }
                    >
                      <CampusMap
                        students={students}
                        cameraLocations={cameraLocations}
                        onSelectStudent={focusStudent}
                        cameras={cameras}
                        campusCenter={campusCenter}
                        zoomLevel={MAP_ZOOM_LEVEL}
                        onCampusCenterChange={handleCampusCenterChange}
                        onCameraPositionChange={handleCameraPositionChange}
                        isExpanded={cameraGridExpanded}
                      />
                    </Suspense>
                  )}
                </motion.div>

                <motion.aside variants={panelVariants} className="space-y-4 xl:col-span-3">
                  <Suspense
                    fallback={
                      <div className="glass-card grid min-h-[180px] place-items-center rounded-2xl border border-white/10 text-sm text-slate-300">
                        Loading recognition metrics...
                      </div>
                    }
                  >
                    <RecognitionMetricsPanel />
                  </Suspense>

                  <Suspense
                    fallback={
                      <div className="glass-card grid min-h-[240px] place-items-center rounded-2xl border border-white/10 text-sm text-slate-300">
                        Loading activity feed...
                      </div>
                    }
                  >
                    <FeedPanel
                      events={events}
                      onEventClick={handleFeedEventClick}
                      selectedStudentId={selectedId}
                    />
                  </Suspense>
                </motion.aside>
              </motion.section>

              <motion.section variants={panelVariants} className="glass-card rounded-2xl border border-white/10">
                <button
                  type="button"
                  className="flex w-full items-center justify-between rounded-2xl px-5 py-4 text-left transition hover:bg-white/[0.04]"
                  onClick={() => setStudentsCollapsed((prev) => !prev)}
                >
                  <div>
                    <h3 className="panel-title">Students Panel</h3>
                    <p className="panel-kicker">
                      Search, inspect, and manage registered students
                    </p>
                  </div>

                  <motion.span
                    animate={{ rotate: studentsCollapsed ? 0 : 180 }}
                    transition={{ duration: 0.2 }}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-cyan-300/35 bg-cyan-500/10 text-xs font-bold text-cyan-200"
                  >
                    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
                      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </motion.span>
                </button>

                <div
                  className={`grid transition-all duration-300 ${
                    studentsCollapsed
                      ? "max-h-0 overflow-hidden opacity-0"
                      : "max-h-[820px] opacity-100"
                  }`}
                >
                  <div className="space-y-4 border-t border-white/10 px-5 py-5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <input
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="Search by name, ID, or program"
                        className="w-full rounded-xl border border-white/15 bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-slate-100 outline-none transition focus:border-cyan-300/50 md:max-w-md"
                      />
                      <button
                        type="button"
                        className="rounded-xl border border-white/15 bg-white/[0.04] px-3 py-2 text-xs font-semibold text-slate-200 transition hover:border-cyan-300/40 hover:text-cyan-100"
                        onClick={() => setSearch("")}
                      >
                        Clear
                      </button>
                    </div>

                    {students.length === 0 ? (
                      <div className="grid min-h-[140px] place-items-center rounded-2xl border border-dashed border-white/20 bg-white/[0.03] text-center text-sm text-slate-300">
                        <div>
                          <p className="font-semibold">No students registered</p>
                          <p className="mt-1 text-xs text-slate-400">
                            Use Register Face to enroll students into the system.
                          </p>
                        </div>
                      </div>
                    ) : null}

                    {students.length > 0 && filteredStudents.length === 0 ? (
                      <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-6 text-center text-sm text-slate-300">
                        No matching students
                      </div>
                    ) : null}

                    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                      <AnimatePresence initial={false} mode="popLayout">
                        {filteredStudents.map((student, index) => (
                          <motion.article
                            layout
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -8 }}
                            transition={{ duration: 0.22, delay: index * 0.03 }}
                            key={student.studentId}
                            ref={(node) => attachStudentCardRef(student.studentId, node)}
                            className={`group rounded-2xl border p-3 transition-all duration-300 ${
                              selectedId === student.studentId
                                ? "border-cyan-300/60 bg-cyan-500/10 shadow-neon-soft"
                                : "border-white/10 bg-white/[0.04] hover:border-cyan-300/35"
                            }`}
                          >
                            <button
                              type="button"
                              className="flex w-full items-start gap-3 text-left"
                              onClick={() => {
                                focusStudent(student.studentId);
                                openStudentDetail(student.studentId);
                              }}
                            >
                              <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-cyan-500/35 to-violet-500/25 text-sm font-bold text-cyan-100">
                                {getInitials(student.name)}
                              </div>

                              <div className="min-w-0 flex-1">
                                <div className="flex items-center justify-between gap-2">
                                  <p className="truncate text-sm font-semibold text-slate-100">
                                    {student.name}
                                  </p>
                                  <span
                                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                                      student.status === "online"
                                        ? "bg-emerald-500/20 text-emerald-200"
                                        : student.status === "alert"
                                          ? "bg-amber-400/20 text-amber-200"
                                          : "bg-slate-500/20 text-slate-300"
                                    }`}
                                  >
                                    {student.status || "offline"}
                                  </span>
                                </div>

                                <p className="truncate text-xs font-medium text-slate-300">
                                  {student.program || "Program not set"}
                                </p>
                                <p className="mt-0.5 text-[11px] uppercase tracking-wider text-slate-400">
                                  {student.studentId}
                                </p>
                                <p className="mt-1 text-[11px] text-slate-400">
                                  {student.currentLocation?.buildingName || "Unknown"} • Last seen{" "}
                                  {formatDateTime(student.currentLocation?.lastSeen)}
                                </p>
                              </div>
                            </button>

                            <div className="mt-3 flex items-center justify-between gap-2">
                              <button
                                type="button"
                                className="rounded-lg border border-cyan-300/35 bg-cyan-500/10 px-2.5 py-1 text-[11px] font-semibold text-cyan-100 transition hover:bg-cyan-500/20"
                                onClick={() => openStudentDetail(student.studentId)}
                              >
                                Open Profile
                              </button>

                              <button
                                type="button"
                                className="rounded-lg border border-red-300/35 bg-red-500/10 px-2.5 py-1 text-[11px] font-semibold text-red-100 transition hover:bg-red-500/20"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  handleDeleteStudent(student);
                                }}
                              >
                                Remove
                              </button>
                            </div>
                          </motion.article>
                        ))}
                      </AnimatePresence>
                    </div>

                    {selectedStudent ? (
                      <div className="rounded-2xl border border-cyan-300/25 bg-cyan-500/10 p-3 text-xs text-cyan-100">
                        Focused student: <strong>{selectedStudent.name}</strong> (
                        {selectedStudent.studentId})
                      </div>
                    ) : null}
                  </div>
                </div>
              </motion.section>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {showRegisterFace ? (
        <RegisterFaceBoundary
          onClose={() => setShowRegisterFace(false)}
          onRetry={() => {
            setShowRegisterFace(false);
            window.setTimeout(() => {
              setShowRegisterFace(true);
            }, 120);
          }}
        >
          <Suspense
            fallback={(
              <div className="fixed inset-0 z-[1500] grid place-items-center bg-[#070b12]/85 px-4 py-6 backdrop-blur-sm">
                <div className="glass-card w-full max-w-md rounded-2xl border border-white/10 bg-[#0e1420]/95 p-4 text-center text-sm text-slate-200">
                  Opening Face Register...
                </div>
              </div>
            )}
          >
            <FaceRegister
              open={showRegisterFace}
              onClose={() => setShowRegisterFace(false)}
              students={students}
              onRegistrationSaved={refreshStudents}
            />
          </Suspense>
        </RegisterFaceBoundary>
      ) : null}

      <AnimatePresence>
        {toastMessage ? (
          <motion.div
            variants={toastVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            className="fixed bottom-6 right-6 z-[1500] rounded-xl border border-cyan-300/35 bg-[#0b1626]/90 px-4 py-2 text-sm text-cyan-100 shadow-neon-soft"
          >
            {toastMessage}
          </motion.div>
        ) : null}
      </AnimatePresence>
      </div>
    </MotionConfig>
  );
}
