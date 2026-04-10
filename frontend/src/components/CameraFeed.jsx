import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { getFaceEngine } from "../lib/faceEngineLoader";
import { buildSignedHeaders } from "../lib/securityHeaders";

const MJPEG_CONNECT_TIMEOUT_MS = 8000;
const PROFILE_TUNING = {
  "extreme-demo": {
    detectionIntervalMs: 110,
    mjpegDetectionIntervalMs: 160,
    drawFrameIntervalMs: 1000 / 18,
    detectionHoldMs: 900,
    detectionCooldownMs: 320,
    matchRequestTimeoutMs: 500,
    backendMatchBackoffMs: 650,
    backendAdaptiveIntervalMinMs: 220,
    backendAdaptiveIntervalMaxMs: 640,
    backendMaxCandidates: 1,
    localEmitConfidenceThreshold: 0.3,
    webcamDetector: {
      inputSize: 224,
      scoreThreshold: 0.05,
      minConfidence: 0.12,
      maxResults: 2,
    },
    mjpegDetector: {
      inputSize: 256,
      scoreThreshold: 0.08,
      minConfidence: 0.12,
      maxResults: 2,
    },
  },
  "ultra-fast": {
    detectionIntervalMs: 170,
    mjpegDetectionIntervalMs: 240,
    drawFrameIntervalMs: 1000 / 22,
    detectionHoldMs: 1200,
    detectionCooldownMs: 450,
    matchRequestTimeoutMs: 700,
    backendMatchBackoffMs: 900,
    backendAdaptiveIntervalMinMs: 320,
    backendAdaptiveIntervalMaxMs: 950,
    backendMaxCandidates: 1,
    localEmitConfidenceThreshold: 0.34,
    webcamDetector: {
      inputSize: 256,
      scoreThreshold: 0.08,
      minConfidence: 0.16,
      maxResults: 3,
    },
    mjpegDetector: {
      inputSize: 320,
      scoreThreshold: 0.1,
      minConfidence: 0.16,
      maxResults: 3,
    },
  },
  precision: {
    detectionIntervalMs: 320,
    mjpegDetectionIntervalMs: 430,
    drawFrameIntervalMs: 1000 / 30,
    detectionHoldMs: 1750,
    detectionCooldownMs: 1000,
    matchRequestTimeoutMs: 1400,
    backendMatchBackoffMs: 1800,
    backendAdaptiveIntervalMinMs: 700,
    backendAdaptiveIntervalMaxMs: 2200,
    backendMaxCandidates: 2,
    localEmitConfidenceThreshold: 0.45,
    webcamDetector: {
      inputSize: 416,
      scoreThreshold: 0.14,
      minConfidence: 0.22,
      maxResults: 6,
    },
    mjpegDetector: {
      inputSize: 416,
      scoreThreshold: 0.14,
      minConfidence: 0.22,
      maxResults: 6,
    },
  },
};
const MJPEG_WIDTH = 640;
const MJPEG_HEIGHT = 480;
const BACKEND =
  import.meta.env.VITE_BACKEND_URL
  || import.meta.env.VITE_API_BASE
  || "http://localhost:5000";
const MJPEG_RECOGNITION_THRESHOLD = Number(
  import.meta.env.VITE_MJPEG_RECOGNITION_THRESHOLD || 0.55
);
const LOCK_SOUND_ENABLED =
  String(import.meta.env.VITE_FACE_LOCK_SOUND || "false").toLowerCase() === "true";
const IDENTITY_REVEAL_DELAY_MIN_MS = 180;
const IDENTITY_REVEAL_DELAY_MAX_MS = 260;
const SWITCHING_DELAY_BASE_MS = 160;
const SWITCHING_DELAY_JITTER_MS = 80;

const proxyUrl = (camUrl) =>
  `${BACKEND}/api/proxy/stream?url=${encodeURIComponent(String(camUrl || ""))}`;

const snapshotUrl = (camUrl) =>
  `${BACKEND}/api/proxy/snapshot?url=${encodeURIComponent(String(camUrl || ""))}`;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function getStatusPriority(statusType) {
  if (statusType === "locked") {
    return 7;
  }
  if (statusType === "switching") {
    return 6;
  }
  if (statusType === "identified" || statusType === "recognizing") {
    return 5;
  }
  if (statusType === "looking" || statusType === "detecting") {
    return 4;
  }
  if (statusType === "temporal") {
    return 3;
  }
  if (statusType === "lost") {
    return 2;
  }
  if (statusType === "unknown") {
    return 1;
  }

  return 0;
}

export default function CameraFeed({
  cameraId,
  cameraLabel,
  stream,
  onDetection,
  isActive,
  suspendProcessing = false,
  detectionProfile = "ultra-fast",
  sourceType = "laptop-webcam",
  streamUrl: cameraStreamUrl = "",
  snapshotUrl: cameraSnapshotUrl = "",
  onRemove,
}) {
  const videoRef = useRef(null);
  const visibleMjpegRef = useRef(null);
  const overlayCanvasRef = useRef(null);
  const stageRef = useRef(null);
  const faceEngineRef = useRef(null);

  const lastDetectionsRef = useRef([]);
  const detectBusyRef = useRef(false);
  const emitCooldownRef = useRef(new Map());
  const lastDrawFrameAtRef = useRef(0);
  const backendMatchBackoffUntilRef = useRef(0);
  const lastBackendMatchAtRef = useRef(0);
  const backendMatchInFlightRef = useRef(false);
  const livenessByTrackRef = useRef(new Map());
  const identityTransitionTimerRef = useRef(null);
  const statusHoldTimerRef = useRef(null);
  const confirmationPulseTimerRef = useRef(null);
  const peakHoldTimerRef = useRef(null);
  const peakHoldActiveRef = useRef(false);
  const lastIdentityRef = useRef("");
  const lastLockCueAtRef = useRef(0);
  const focusShellRef = useRef(null);
  const statusToneMemoryRef = useRef("idle");
  const switchingDelayJitterRef = useRef(0);
  const identityRevealDelayRef = useRef(210);
  const confidenceBoostRef = useRef(0.072);
  const scanPhaseRef = useRef("idle");
  const anticipationFlagRef = useRef(false);
  const organicCycleRef = useRef({
    scanDurationSec: 1.86,
    ringThicknessPx: 2,
    glowIntensity: 1,
    beamDurationSec: 1.72,
    jitterOffsetSec: 0,
    softOpacity: 0.35,
    eccentricity: 1,
  });

  const [isConnecting, setIsConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const [retryNonce, setRetryNonce] = useState(0);
  const [mjpegReady, setMjpegReady] = useState(false);
  const [isDetecting, setIsDetecting] = useState(false);
  const [statusInfo, setStatusInfo] = useState({
    type: "idle",
    text: "No face detected",
    confidence: 0,
    identityName: "",
  });
  const [statusDisplay, setStatusDisplay] = useState({
    key: 0,
    type: "idle",
    text: "No face detected",
    confidence: 0,
    identityName: "",
  });
  const statusTransitionTimerRef = useRef(null);
  const [focusTarget, setFocusTarget] = useState({
    visible: false,
    centerXPct: 0.5,
    centerYPct: 0.5,
    sizePct: 0.3,
    confidence: 0,
    phase: "idle",
  });
  const [identityDisplay, setIdentityDisplay] = useState({
    key: 0,
    name: "",
    visible: false,
  });
  const [preConfirmHold, setPreConfirmHold] = useState(false);
  const [confirmationPulseActive, setConfirmationPulseActive] = useState(false);

  const isMjpegSource = Boolean(cameraStreamUrl) && sourceType !== "laptop-webcam";
  const activeProfileKey =
    detectionProfile === "precision"
      ? "precision"
      : detectionProfile === "extreme-demo"
        ? "extreme-demo"
        : "ultra-fast";
  const runtimeTuning = PROFILE_TUNING[activeProfileKey] || PROFILE_TUNING["ultra-fast"];
  const aggressiveMode = activeProfileKey !== "precision";

  const ensureFaceEngine = useCallback(async () => {
    if (faceEngineRef.current) {
      return faceEngineRef.current;
    }

    const engine = await getFaceEngine();
    faceEngineRef.current = engine;
    return engine;
  }, []);

  const streamUrl = useMemo(() => {
    if (!cameraStreamUrl) {
      return "";
    }

    if (retryNonce <= 0) {
      return cameraStreamUrl;
    }

    return `${cameraStreamUrl}${cameraStreamUrl.includes("?") ? "&" : "?"}retry=${retryNonce}`;
  }, [cameraStreamUrl, retryNonce]);

  const proxiedStreamUrl = useMemo(() => {
    if (!streamUrl) {
      return "";
    }

    return proxyUrl(streamUrl);
  }, [streamUrl]);

  const fallbackSnapshotSourceUrl = useMemo(() => {
    if (!streamUrl) {
      return "";
    }

    if (streamUrl.includes("/video")) {
      return streamUrl.replace("/video", "/jpeg");
    }

    return streamUrl;
  }, [streamUrl]);

  const proxiedSnapshotUrl = useMemo(() => {
    const snapSource = cameraSnapshotUrl || fallbackSnapshotSourceUrl;
    if (!snapSource) {
      return "";
    }

    return snapshotUrl(snapSource);
  }, [cameraSnapshotUrl, fallbackSnapshotSourceUrl]);

  const handleMjpegLoad = () => {
    setIsConnecting(false);
    setMjpegReady(true);
    setConnectionError("");
  };

  const handleMjpegError = () => {
    setIsConnecting(false);
    setMjpegReady(false);
    setConnectionError("Cannot reach camera. Check WiFi.");
  };

  useEffect(() => {
    if (isMjpegSource) {
      return undefined;
    }

    const video = videoRef.current;
    if (!video) {
      return undefined;
    }

    if (suspendProcessing) {
      try {
        video.pause?.();
      } catch (error) {
        // Ignore pause failures.
      }

      video.srcObject = null;
      return undefined;
    }

    if (!stream) {
      return undefined;
    }

    video.srcObject = stream;
    video
      .play()
      .then(() => undefined)
      .catch(() => undefined);

    return () => {
      if (video.srcObject === stream) {
        video.srcObject = null;
      }
    };
  }, [isMjpegSource, stream, suspendProcessing]);

  useEffect(() => {
    if (!isMjpegSource || !isActive || !proxiedStreamUrl || suspendProcessing) {
      setIsConnecting(false);
      setConnectionError("");
      setMjpegReady(false);
      return undefined;
    }

    setIsConnecting(true);
    setConnectionError("");
    setMjpegReady(false);
    setStatusInfo({ type: "idle", text: "No face detected", confidence: 0, identityName: "" });
    lastDetectionsRef.current = [];
  }, [isActive, isMjpegSource, proxiedStreamUrl, suspendProcessing]);

  useEffect(() => {
    if (
      !isMjpegSource
      || !isActive
      || !proxiedStreamUrl
      || !isConnecting
      || mjpegReady
      || connectionError
      || suspendProcessing
    ) {
      return undefined;
    }

    const timeoutId = setTimeout(() => {
      setIsConnecting(false);
      setMjpegReady(false);
      setConnectionError("Cannot reach camera. Check WiFi.");
    }, MJPEG_CONNECT_TIMEOUT_MS);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [
    connectionError,
    isActive,
    isConnecting,
    isMjpegSource,
    mjpegReady,
    proxiedStreamUrl,
    suspendProcessing,
  ]);

  const loadSnapshotForDetection = useCallback(async () => {
    if (!proxiedSnapshotUrl) {
      throw new Error("Snapshot URL is unavailable");
    }

    const response = await fetch(proxiedSnapshotUrl, {
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`Snapshot request failed (${response.status})`);
    }

    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);

    try {
      const image = await new Promise((resolve, reject) => {
        const imageElement = new Image();
        imageElement.onload = () => resolve(imageElement);
        imageElement.onerror = () => reject(new Error("Snapshot decode failed"));
        imageElement.src = objectUrl;
      });

      return image;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }, [proxiedSnapshotUrl]);

  const matchDescriptorWithBackend = useCallback(
    async ({
      descriptor,
      timestamp,
      trackHint,
      box,
      detectDurationMs,
      ingestToDetectMs,
      liveness,
    }) => {
      if (!Array.isArray(descriptor) || descriptor.length === 0) {
        return { mode: "skipped", payload: null };
      }

      if (Date.now() < backendMatchBackoffUntilRef.current) {
        return { mode: "unavailable", payload: null };
      }

      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timeoutId = controller
        ? window.setTimeout(() => controller.abort(), runtimeTuning.matchRequestTimeoutMs)
        : null;

      try {
        const requestedThresholdDistance = isMjpegSource
          ? Math.max(0.35, Math.min(0.65, MJPEG_RECOGNITION_THRESHOLD))
          : undefined;

        const requestPayload = {
          descriptor,
          cameraId,
          cameraLabel,
          thresholdDistance: requestedThresholdDistance,
          timestamp,
          trackHint,
          box,
          detectDurationMs,
          ingestToDetectMs,
          liveness,
        };

        const headers = await buildSignedHeaders({
          payload: requestPayload,
          scope: "recognition.match",
          headers: {
            "Content-Type": "application/json",
          },
        });

        const response = await fetch(`${BACKEND}/api/recognition/match`, {
          method: "POST",
          headers,
          body: JSON.stringify(requestPayload),
          signal: controller?.signal,
        });

        if (!response.ok) {
          if (response.status >= 500) {
            backendMatchBackoffUntilRef.current = Date.now() + runtimeTuning.backendMatchBackoffMs;
          }

          return { mode: "error", payload: null };
        }

        const payload = await response.json();
        return { mode: "ok", payload };
      } catch (error) {
        backendMatchBackoffUntilRef.current = Date.now() + runtimeTuning.backendMatchBackoffMs;
        return { mode: "error", payload: null };
      } finally {
        if (timeoutId) {
          window.clearTimeout(timeoutId);
        }
      }
    },
    [
      cameraId,
      cameraLabel,
      isMjpegSource,
      runtimeTuning.backendMatchBackoffMs,
      runtimeTuning.matchRequestTimeoutMs,
    ]
  );

  const buildLocalLivenessSignal = useCallback((item, sourceWidth, sourceHeight, observedAt) => {
    const safeWidth = Math.max(1, Number(sourceWidth || 1));
    const safeHeight = Math.max(1, Number(sourceHeight || 1));
    const box = item?.box;
    const trackId = String(item?.trackId || "");

    if (!box || !trackId) {
      return {
        motionPx: 0,
        areaRatio: 0,
        localConfidence: Number(item?.emitConfidence ?? item?.match?.confidence ?? 0),
        sampleAgeMs: 0,
      };
    }

    const centerX = Number(box.x || 0) + Number(box.width || 0) / 2;
    const centerY = Number(box.y || 0) + Number(box.height || 0) / 2;
    const areaRatio =
      Math.max(0, Number(box.width || 0)) * Math.max(0, Number(box.height || 0))
      / (safeWidth * safeHeight);

    const previous = livenessByTrackRef.current.get(trackId) || null;
    const motionPx = previous
      ? Math.hypot(centerX - Number(previous.x || 0), centerY - Number(previous.y || 0))
      : 0;
    const sampleAgeMs = previous
      ? Math.max(0, observedAt - Number(previous.at || observedAt))
      : 0;

    livenessByTrackRef.current.set(trackId, {
      x: centerX,
      y: centerY,
      at: observedAt,
    });

    if (livenessByTrackRef.current.size > 120) {
      const cutoff = observedAt - 15000;
      for (const [key, value] of livenessByTrackRef.current.entries()) {
        if (Number(value?.at || 0) < cutoff) {
          livenessByTrackRef.current.delete(key);
        }
      }
    }

    return {
      motionPx: Number(motionPx.toFixed(3)),
      areaRatio: Number(Math.max(0, Math.min(1, areaRatio)).toFixed(4)),
      localConfidence: Number(item?.emitConfidence ?? item?.match?.confidence ?? 0),
      sampleAgeMs,
    };
  }, []);

  const playLockCue = useCallback(() => {
    if (!LOCK_SOUND_ENABLED || typeof window === "undefined") {
      return;
    }

    const now = Date.now();
    if (now - lastLockCueAtRef.current < 600) {
      return;
    }

    lastLockCueAtRef.current = now;

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      return;
    }

    try {
      const audioCtx = new AudioContextClass();
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();

      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(720, audioCtx.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(980, audioCtx.currentTime + 0.12);

      gainNode.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.028, audioCtx.currentTime + 0.025);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.16);

      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      oscillator.start(audioCtx.currentTime);
      oscillator.stop(audioCtx.currentTime + 0.17);

      oscillator.onended = () => {
        gainNode.disconnect();
        audioCtx.close().catch(() => undefined);
      };
    } catch (error) {
      // Optional cue only; ignore runtime audio errors.
    }
  }, []);

  const applyOrganicCycleVars = useCallback((cycleProfile) => {
    const shell = focusShellRef.current;
    if (shell) {
      shell.style.setProperty("--scan-duration", `${cycleProfile.scanDurationSec}s`);
      shell.style.setProperty("--ring-thickness", `${cycleProfile.ringThicknessPx}px`);
      shell.style.setProperty("--focus-glow-intensity", String(cycleProfile.glowIntensity));
      shell.style.setProperty("--scan-jitter-offset", `${cycleProfile.jitterOffsetSec}s`);
      shell.style.setProperty("--soft-ring-opacity", String(cycleProfile.softOpacity));
      shell.style.setProperty("--ring-eccentricity", String(cycleProfile.eccentricity));
    }

    const stage = stageRef.current;
    if (stage) {
      stage.style.setProperty("--beam-duration", `${cycleProfile.beamDurationSec}s`);
    }
  }, []);

  const buildOrganicCycleProfile = useCallback((phase, uiConfidence) => {
    const anticipating = phase === "recognizing" && uiConfidence >= 0.85;
    const rawDuration = randomBetween(1.6, 2.2);
    const scanDurationSec = Number(
      clamp(
        anticipating ? rawDuration + randomBetween(0.08, 0.16) : rawDuration,
        1.6,
        2.2
      ).toFixed(3)
    );

    return {
      scanDurationSec,
      ringThicknessPx: Number(randomBetween(1.78, 2.42).toFixed(3)),
      glowIntensity: Number(
        clamp(
          randomBetween(0.92, 1.1) + (anticipating ? randomBetween(0.05, 0.12) : 0),
          0.9,
          1.24
        ).toFixed(3)
      ),
      beamDurationSec: Number(clamp(scanDurationSec + randomBetween(-0.16, 0.14), 1.45, 2.25).toFixed(3)),
      jitterOffsetSec: Number(randomBetween(-0.08, 0.08).toFixed(3)),
      softOpacity: Number(randomBetween(0.3, 0.44).toFixed(3)),
      eccentricity: Number(randomBetween(0.988, 1.02).toFixed(3)),
    };
  }, []);

  const refreshOrganicCycleProfile = useCallback((phase, uiConfidence) => {
    const cycleProfile = buildOrganicCycleProfile(phase, uiConfidence);
    organicCycleRef.current = cycleProfile;
    applyOrganicCycleVars(cycleProfile);
  }, [applyOrganicCycleVars, buildOrganicCycleProfile]);

  const handleScanRingIteration = useCallback((event) => {
    if (event?.animationName && event.animationName !== "perception-ring-spin") {
      return;
    }

    const phase = scanPhaseRef.current;
    if (phase !== "recognizing" && phase !== "switching") {
      return;
    }

    refreshOrganicCycleProfile(phase, Number(statusDisplay.confidence || 0));
  }, [refreshOrganicCycleProfile, statusDisplay.confidence]);

  const updateFocusTargetFromDetections = useCallback((detections, sourceWidth, sourceHeight) => {
    if (!Array.isArray(detections) || detections.length === 0) {
      setFocusTarget((previous) => ({
        ...previous,
        visible: false,
        phase: "lost",
        confidence: Math.max(0.18, previous.confidence * 0.6),
      }));
      return;
    }

    const safeSourceWidth = Math.max(1, Number(sourceWidth || 1));
    const safeSourceHeight = Math.max(1, Number(sourceHeight || 1));

    const best = detections.reduce((acc, current) => {
      if (!acc) {
        return current;
      }

      const rankA = getStatusPriority(acc.statusType);
      const rankB = getStatusPriority(current.statusType);
      if (rankB > rankA) {
        return current;
      }

      if (rankA === rankB) {
        const confA = Number(acc.displayConfidence ?? acc.match?.confidence ?? acc.emitConfidence ?? 0);
        const confB = Number(current.displayConfidence ?? current.match?.confidence ?? current.emitConfidence ?? 0);
        if (confB > confA) {
          return current;
        }
      }

      return acc;
    }, null);

    const box = best?.box;
    if (!box) {
      setFocusTarget((previous) => ({
        ...previous,
        visible: false,
        phase: "lost",
      }));
      return;
    }

    const centerXPct = clamp((Number(box.x || 0) + Number(box.width || 0) / 2) / safeSourceWidth, 0.04, 0.96);
    const centerYPct = clamp((Number(box.y || 0) + Number(box.height || 0) / 2) / safeSourceHeight, 0.07, 0.93);
    const sizeRatio = Math.max(
      Number(box.width || 0) / safeSourceWidth,
      Number(box.height || 0) / safeSourceHeight
    );
    const sizePct = clamp(sizeRatio * 1.22, 0.2, 0.62);

    setFocusTarget({
      visible: true,
      centerXPct,
      centerYPct,
      sizePct,
      confidence: clamp(Number(best?.displayConfidence ?? best?.match?.confidence ?? best?.emitConfidence ?? 0), 0, 1),
      phase: String(best?.statusType || "looking"),
    });
  }, []);

  const updateStatusFromDetections = useCallback((detections) => {
    if (!Array.isArray(detections) || detections.length === 0) {
      setStatusInfo({ type: "idle", text: "No face detected", confidence: 0, identityName: "" });
      return;
    }

    const best = detections.reduce((acc, current) => {
      if (!acc) {
        return current;
      }

      const rankA = getStatusPriority(acc.statusType);
      const rankB = getStatusPriority(current.statusType);
      if (rankB > rankA) {
        return current;
      }

      if (rankA === rankB) {
        const confA = Number(acc.match?.confidence ?? acc.emitConfidence ?? 0);
        const confB = Number(current.match?.confidence ?? current.emitConfidence ?? 0);
        if (confB > confA) {
          return current;
        }
      }

      return acc;
    }, null);

    const nextType = best?.statusType || "unknown";
    const nextText = String(
      best?.displayLabel || (nextType === "unknown" ? "Unknown person" : "Face detected")
    );
    const nextConfidence = Number(
      best?.displayConfidence
      ?? best?.match?.confidence
      ?? best?.emitConfidence
      ?? 0
    );

    setStatusInfo({
      type: nextType,
      text: nextText,
      confidence: Math.max(0, Math.min(1, Number.isFinite(nextConfidence) ? nextConfidence : 0)),
      identityName: String(best?.identityName || best?.match?.name || ""),
    });
  }, []);

  const resolveDetectionWithBackend = useCallback((item, backendPayload) => {
    const backendBest = backendPayload?.best || null;
    const backendDecision = String(backendPayload?.pipeline?.decision || "");
    const backendMatched = Boolean(backendPayload?.matched && backendBest?.studentId);
    const uiState = backendPayload?.uiState || backendPayload?.pipeline?.stability?.uiState || null;
    const semanticPhase = String(uiState?.phase || "").toLowerCase();
    const legacyPhase = String(uiState?.phaseLegacy || "").toLowerCase();
    const uiPhase = semanticPhase || legacyPhase;
    const uiLabel = String(uiState?.message || uiState?.label || "").trim();
    const uiConfidenceLevel = String(uiState?.confidenceLevel || "").toLowerCase();
    const uiConfidenceHint =
      uiConfidenceLevel === "high"
        ? 0.9
        : uiConfidenceLevel === "medium"
          ? 0.68
          : uiConfidenceLevel === "low"
            ? 0.42
            : Number(item?.displayConfidence ?? item?.match?.confidence ?? 0);
    const resolvedAt = Date.now();

    if (uiPhase === "switching") {
      const switchingName = String(
        backendBest?.studentName
          || backendPayload?.stableId
          || item?.match?.name
          || "candidate"
      );

      return {
        ...item,
        match: null,
        statusType: "switching",
        displayLabel: uiLabel || `Switching to ${switchingName}...`,
        boxColor: "#f59e0b",
        boxDashed: true,
        shouldEmit: false,
        emitConfidence: 0,
        displayConfidence: Number(uiConfidenceHint || 0.5),
        identityName: switchingName,
        backendResolved: true,
        lastSeenAt: resolvedAt,
      };
    }

    if (uiPhase === "looking" || uiPhase === "detecting") {
      return {
        ...item,
        match: null,
        statusType: "looking",
        displayLabel: uiLabel || "Looking...",
        boxColor: "#38bdf8",
        boxDashed: true,
        shouldEmit: false,
        emitConfidence: 0,
        displayConfidence: Number(uiConfidenceHint || 0.34),
        identityName: "",
        backendResolved: true,
        lastSeenAt: resolvedAt,
      };
    }

    if (uiPhase === "recognizing" || uiPhase === "stable") {
      const personName = String(
        backendBest?.studentName
          || backendPayload?.stableId
          || item?.match?.name
          || "Candidate"
      );

      return {
        ...item,
        match: null,
        statusType: "recognizing",
        displayLabel: uiLabel || `Recognizing ${personName}...`,
        boxColor: "#818cf8",
        boxDashed: true,
        shouldEmit: false,
        emitConfidence: 0,
        displayConfidence: Number(uiConfidenceHint || 0.56),
        identityName: personName,
        backendResolved: true,
        lastSeenAt: resolvedAt,
      };
    }

    if (backendMatched) {
      const confidence = Number(backendBest.confidence || 0);
      const normalizedConfidence = Number(
        Math.max(0, Math.min(1, confidence)).toFixed(3)
      );
      const confidencePct = Math.round(normalizedConfidence * 100);
      const personId = String(backendBest.studentId || "");
      const personName = String(
        backendBest.studentName || backendPayload?.student?.name || "Unknown"
      );
      const isLocked = uiPhase === "locked" || Boolean(uiState?.isLocked);
      const isRecognizing = uiPhase === "recognizing" || uiPhase === "stable";

      return {
        ...item,
        match: {
          personId,
          name: personName,
          confidence: normalizedConfidence,
          distance: Number.isFinite(Number(backendBest.distance))
            ? Number(backendBest.distance)
            : null,
          mode: "backend",
        },
        statusType: isLocked ? "locked" : isRecognizing ? "recognizing" : "identified",
        displayLabel: isLocked
          ? uiLabel || `Locked: ${personName} ${confidencePct}%`
          : isRecognizing
            ? uiLabel || `Recognizing ${personName} ${confidencePct}%`
          : `${personName} ${confidencePct}%`,
        boxColor: isLocked ? "#22d3ee" : isRecognizing ? "#818cf8" : "#00ff88",
        boxDashed: false,
        shouldEmit: false,
        emitConfidence: 0,
        displayConfidence: normalizedConfidence,
        identityName: personName,
        backendResolved: true,
        lastSeenAt: resolvedAt,
      };
    }

    if (
      (backendDecision === "pending" || backendDecision === "liveness_pending")
      && backendBest?.studentId
    ) {
      const personName = String(backendBest.studentName || "Candidate");
      const confidence = Number(backendBest.confidence || 0);
      const confidencePct = Math.round(
        Math.max(0, Math.min(1, confidence)) * 100
      );

      return {
        ...item,
        match: null,
        statusType: uiPhase === "recognizing" ? "recognizing" : "looking",
        displayLabel: uiLabel || `${personName} analyzing ${confidencePct}%`,
        boxColor: "#38bdf8",
        boxDashed: true,
        shouldEmit: false,
        emitConfidence: 0,
        displayConfidence: Math.max(0.3, Math.min(1, confidence)),
        identityName: personName,
        backendResolved: true,
        lastSeenAt: resolvedAt,
      };
    }

    if (uiPhase === "lost") {
      return {
        ...item,
        match: null,
        statusType: "lost",
        displayLabel: uiLabel || "Identity lost",
        boxColor: "#94a3b8",
        boxDashed: true,
        shouldEmit: false,
        emitConfidence: 0,
        displayConfidence: 0.2,
        identityName: "",
        backendResolved: true,
        lastSeenAt: resolvedAt,
      };
    }

    return {
      ...item,
      match: null,
      statusType: "unknown",
      displayLabel: "Unknown",
      boxColor: "#ffd447",
      boxDashed: false,
      shouldEmit: false,
      emitConfidence: 0,
      displayConfidence: 0.35,
      identityName: "",
      backendResolved: true,
      lastSeenAt: resolvedAt,
    };
  }, []);

  useEffect(() => {
    if (suspendProcessing) {
      const canvas = overlayCanvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        ctx?.clearRect(0, 0, canvas.width, canvas.height);
      }

      return undefined;
    }

    let rafId = 0;

    const draw = (timestamp) => {
      if (timestamp - lastDrawFrameAtRef.current < runtimeTuning.drawFrameIntervalMs) {
        rafId = requestAnimationFrame(draw);
        return;
      }
      lastDrawFrameAtRef.current = timestamp;

      const canvas = overlayCanvasRef.current;
      if (!canvas) {
        rafId = requestAnimationFrame(draw);
        return;
      }

      const displaySource = isMjpegSource ? visibleMjpegRef.current : videoRef.current;
      const displayWidth = Math.max(1, displaySource?.offsetWidth || canvas.parentElement?.clientWidth || MJPEG_WIDTH);
      const displayHeight = Math.max(1, displaySource?.offsetHeight || canvas.parentElement?.clientHeight || MJPEG_HEIGHT);

      canvas.width = displayWidth;
      canvas.height = displayHeight;

      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const sourceWidth = isMjpegSource
        ? Math.max(1, displaySource?.naturalWidth || MJPEG_WIDTH)
        : Math.max(1, displaySource?.videoWidth || displayWidth);
      const sourceHeight = isMjpegSource
        ? Math.max(1, displaySource?.naturalHeight || MJPEG_HEIGHT)
        : Math.max(1, displaySource?.videoHeight || displayHeight);

      const scaleX = displayWidth / sourceWidth;
      const scaleY = displayHeight / sourceHeight;

      const now = Date.now();
      const activeDetections = lastDetectionsRef.current.filter(
        (item) => now - item.lastSeenAt <= runtimeTuning.detectionHoldMs
      );
      lastDetectionsRef.current = activeDetections;

      activeDetections.forEach((item) => {
        const box = item.box;
        if (!box) {
          return;
        }

        const x = Number(box.x || 0) * scaleX;
        const y = Number(box.y || 0) * scaleY;
        const w = Math.max(1, Number(box.width || 0) * scaleX);
        const h = Math.max(1, Number(box.height || 0) * scaleY);

        const label =
          item.statusType === "locked" || item.statusType === "identified"
            ? String(item.identityName || item.match?.name || "Verified")
            : item.statusType === "recognizing"
              ? "Scanning..."
              : item.statusType === "switching"
                ? "Re-evaluating..."
                : item.statusType === "looking"
                  ? "Focus"
                  : item.statusType === "lost"
                    ? "Face lost"
                    : "";
        const labelColor = String(item.boxColor || "#ffd447");

        ctx.lineWidth = 2.5;
        ctx.strokeStyle = labelColor;
        ctx.setLineDash(item.boxDashed ? [8, 6] : []);
        ctx.strokeRect(x, y, w, h);
        ctx.setLineDash([]);

        if (label) {
          ctx.font = "600 12px Segoe UI";
          const nameWidth = ctx.measureText(label).width;
          const labelTop = Math.max(0, y - 24);
          const labelTextY = Math.max(14, y - 8);

          ctx.fillStyle = "rgba(0,0,0,0.62)";
          ctx.fillRect(x, labelTop, nameWidth + 8, 21);
          ctx.fillStyle = labelColor;
          ctx.fillText(label, x + 4, labelTextY);
        }
      });

      rafId = requestAnimationFrame(draw);
    };

    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, [isMjpegSource, runtimeTuning, suspendProcessing]);

  useEffect(() => {
    if (!isActive || suspendProcessing) {
      lastDetectionsRef.current = [];
      detectBusyRef.current = false;
      backendMatchInFlightRef.current = false;
      livenessByTrackRef.current.clear();
      setStatusInfo({
        type: "idle",
        text: suspendProcessing && isActive ? "Paused while registering face" : "No face detected",
        confidence: 0,
        identityName: "",
      });
      setFocusTarget((previous) => ({
        ...previous,
        visible: false,
        phase: "idle",
        confidence: 0,
      }));
      setIdentityDisplay((previous) => ({
        ...previous,
        visible: false,
      }));
      setIsDetecting(false);
      return undefined;
    }

    let stopped = false;

    const detect = async () => {
      if (stopped || detectBusyRef.current) {
        return;
      }

      let source = videoRef.current;

      if (isMjpegSource) {
        if (!mjpegReady || isConnecting || !proxiedSnapshotUrl) {
          return;
        }

        try {
          source = await loadSnapshotForDetection();
          setConnectionError("");
        } catch (error) {
          setConnectionError("Cannot reach camera. Check WiFi.");
          setStatusInfo({ type: "idle", text: "No face detected", confidence: 0, identityName: "" });
          return;
        }
      } else {
        if (!source || source.readyState < 2) {
          return;
        }
      }

      detectBusyRef.current = true;
      setIsDetecting(true);

      try {
        const displaySource = isMjpegSource ? visibleMjpegRef.current : videoRef.current;
        const displayWidth = Number(displaySource?.offsetWidth || 0);
        const distanceMode = displayWidth > 800;
        const faceEngine = await ensureFaceEngine();

        const detectStartedAt =
          typeof performance !== "undefined" ? performance.now() : Date.now();

        const detectionOptions = isMjpegSource
          ? {
              realtime: true,
              upscaleFactor: 1,
              inputSize: runtimeTuning.mjpegDetector.inputSize,
              scoreThreshold: runtimeTuning.mjpegDetector.scoreThreshold,
              minConfidence: runtimeTuning.mjpegDetector.minConfidence,
              maxResults: runtimeTuning.mjpegDetector.maxResults,
            }
          : {
              realtime: true,
              distanceMode,
              upscaleFactor: 1,
              inputSize: runtimeTuning.webcamDetector.inputSize,
              scoreThreshold: runtimeTuning.webcamDetector.scoreThreshold,
              minConfidence: runtimeTuning.webcamDetector.minConfidence,
              maxResults: runtimeTuning.webcamDetector.maxResults,
            };

        const results = await faceEngine.processVideoFrame(source, detectionOptions);

        const sourceWidth = Math.max(
          1,
          Number(
            isMjpegSource
              ? source?.naturalWidth || MJPEG_WIDTH
              : source?.videoWidth || source?.width || 0
          ) || MJPEG_WIDTH
        );
        const sourceHeight = Math.max(
          1,
          Number(
            isMjpegSource
              ? source?.naturalHeight || MJPEG_HEIGHT
              : source?.videoHeight || source?.height || 0
          ) || MJPEG_HEIGHT
        );

        const detectFinishedAt =
          typeof performance !== "undefined" ? performance.now() : Date.now();
        const detectDurationMs = Number(
          Math.max(0, detectFinishedAt - detectStartedAt).toFixed(2)
        );

        const now = Date.now();

        const normalized = results
          .map((item, index) => {
            const box = item?.box || item?.detection?.box;
            if (!box) {
              return null;
            }

            const fallbackStatusType = [
              "identified",
              "recognizing",
              "locked",
              "switching",
              "looking",
              "detecting",
              "temporal",
              "lost",
              "unknown",
            ].includes(
              item?.statusType
            )
              ? item.statusType
              : item?.match
                ? "identified"
                : "unknown";

            return {
              trackId: String(item?.trackId || `${cameraId}-${index}`),
              descriptor: Array.isArray(item?.descriptor) ? item.descriptor : [],
              match: item?.match || null,
              box,
              displayLabel: String(item?.displayLabel || item?.match?.name || "Unknown"),
              statusType: fallbackStatusType,
              boxColor: String(
                item?.boxColor
                  || (fallbackStatusType === "identified" || fallbackStatusType === "temporal"
                    ? "#00ff88"
                    : "#ffd447")
              ),
              boxDashed: Boolean(item?.boxDashed),
              shouldEmit: Boolean(item?.shouldEmit),
              emitConfidence: Number(item?.emitConfidence ?? item?.match?.confidence ?? 0),
              displayConfidence: Number(item?.emitConfidence ?? item?.match?.confidence ?? 0),
              identityName: String(item?.identityName || item?.match?.name || ""),
              backendResolved: false,
              lastSeenAt: now,
            };
          })
          .filter(Boolean);

        if (normalized.length > 0) {
          lastDetectionsRef.current = normalized;
        }

        updateFocusTargetFromDetections(normalized, sourceWidth, sourceHeight);
        updateStatusFromDetections(normalized);

        normalized.forEach((item) => {
          if (item.backendResolved) {
            return;
          }

          if (!item.match || !item.shouldEmit) {
            return;
          }

          const confidence = Number(item.emitConfidence ?? item.match.confidence ?? 0);
          if (!Number.isFinite(confidence) || confidence <= runtimeTuning.localEmitConfidenceThreshold) {
            return;
          }

          const dedupeKey = `${cameraId}:${item.match.personId}`;
          const last = emitCooldownRef.current.get(dedupeKey) || 0;
          if (now - last < runtimeTuning.detectionCooldownMs) {
            return;
          }

          emitCooldownRef.current.set(dedupeKey, now);
          onDetection({
            studentId: item.match.personId,
            studentName: item.match.name,
            cameraId,
            cameraLabel,
            confidence,
            timestamp: new Date().toISOString(),
          });
        });

        const adaptiveBackendIntervalMs = aggressiveMode
          ? Math.min(
              runtimeTuning.backendAdaptiveIntervalMaxMs,
              Math.max(
                runtimeTuning.backendAdaptiveIntervalMinMs,
                Math.round(520 + detectDurationMs * 1.35 + Math.max(0, normalized.length - 1) * 180)
              )
            )
          : runtimeTuning.backendAdaptiveIntervalMinMs;

        const canRunBackend =
          !backendMatchInFlightRef.current
          && now >= backendMatchBackoffUntilRef.current
          && now - lastBackendMatchAtRef.current >= adaptiveBackendIntervalMs;

        if (canRunBackend && normalized.length > 0) {
          const backendCandidates = normalized
            .filter((item) => Array.isArray(item.descriptor) && item.descriptor.length > 0)
            .sort((left, right) => {
              const rankDelta = getStatusPriority(right.statusType) - getStatusPriority(left.statusType);
              if (rankDelta !== 0) {
                return rankDelta;
              }

              const confLeft = Number(left.match?.confidence ?? left.emitConfidence ?? 0);
              const confRight = Number(right.match?.confidence ?? right.emitConfidence ?? 0);
              return confRight - confLeft;
            })
            .slice(0, runtimeTuning.backendMaxCandidates);

          if (backendCandidates.length > 0) {
            backendMatchInFlightRef.current = true;
            lastBackendMatchAtRef.current = now;

            const detectionTimestamp = new Date().toISOString();

            void (async () => {
              try {
                const backendMatches = await Promise.all(
                  backendCandidates.map((item) =>
                    matchDescriptorWithBackend({
                      descriptor: item.descriptor,
                      timestamp: detectionTimestamp,
                      trackHint: item.trackId,
                      box: item.box,
                      detectDurationMs,
                      ingestToDetectMs: detectDurationMs,
                      liveness: buildLocalLivenessSignal(
                        item,
                        sourceWidth,
                        sourceHeight,
                        now
                      ),
                    })
                  )
                );

                if (stopped) {
                  return;
                }

                const backendByTrackId = new Map();
                backendCandidates.forEach((item, index) => {
                  backendByTrackId.set(item.trackId, backendMatches[index]);
                });

                const merged = lastDetectionsRef.current.map((item) => {
                  const backendResult = backendByTrackId.get(item.trackId);
                  if (!backendResult || backendResult.mode !== "ok") {
                    return item;
                  }

                  return resolveDetectionWithBackend(item, backendResult.payload || null);
                });

                if (merged.length > 0) {
                  lastDetectionsRef.current = merged;
                  updateFocusTargetFromDetections(merged, sourceWidth, sourceHeight);
                  updateStatusFromDetections(merged);
                }
              } catch (error) {
                // Keep local detections running even if backend refinement fails.
              } finally {
                backendMatchInFlightRef.current = false;
              }
            })();
          }
        }
      } catch (error) {
        if (isMjpegSource) {
          setConnectionError("Cannot reach camera. Check WiFi.");
          setStatusInfo({ type: "idle", text: "No face detected", confidence: 0, identityName: "" });
        }
      } finally {
        detectBusyRef.current = false;
        setIsDetecting(false);
      }
    };

    const intervalMs = isMjpegSource
      ? runtimeTuning.mjpegDetectionIntervalMs
      : runtimeTuning.detectionIntervalMs;
    const timer = setInterval(detect, intervalMs);
    detect();

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [
    cameraId,
    cameraLabel,
    ensureFaceEngine,
    isActive,
    isConnecting,
    isMjpegSource,
    loadSnapshotForDetection,
    matchDescriptorWithBackend,
    mjpegReady,
    onDetection,
    proxiedSnapshotUrl,
    resolveDetectionWithBackend,
    runtimeTuning,
    suspendProcessing,
    aggressiveMode,
    buildLocalLivenessSignal,
    updateFocusTargetFromDetections,
    updateStatusFromDetections,
  ]);

  const retryMjpegConnection = () => {
    setConnectionError("");
    setIsConnecting(true);
    setMjpegReady(false);
    setRetryNonce((prev) => prev + 1);
  };

  const handleToggleFullscreen = () => {
    const target = stageRef.current;
    if (!target) {
      return;
    }

    if (document.fullscreenElement) {
      document.exitFullscreen?.();
      return;
    }

    target.requestFullscreen?.();
  };

  const hasConnectionError = Boolean(connectionError);

  const stateLabel = suspendProcessing
    ? "Paused"
    : isMjpegSource
      ? hasConnectionError
        ? "Error"
        : isConnecting
          ? "Connecting"
          : "Live"
      : "Live";

  const normalizedStatusType = String(statusInfo.type || "idle");

  const statusTone = isDetecting
    ? (["locked", "switching", "looking", "recognizing", "identified"].includes(normalizedStatusType)
      ? normalizedStatusType
      : "looking")
    : normalizedStatusType === "temporal"
      ? "recognizing"
      : ["identified", "locked", "switching", "looking", "recognizing", "lost", "unknown"].includes(normalizedStatusType)
        ? normalizedStatusType
        : "idle";

  const statusText =
    isDetecting && !["locked", "switching", "looking", "recognizing"].includes(statusTone)
      ? "Looking..."
      : String(statusInfo.text || "No face detected");
  const statusIdentity = String(statusInfo.identityName || "");

  const toneClass = (tone) => (
    tone === "identified"
      ? "text-emerald-300"
      : tone === "locked"
        ? "text-emerald-200"
        : tone === "switching"
          ? "text-amber-300"
          : tone === "looking"
            ? "text-sky-200"
            : tone === "recognizing"
              ? "text-cyan-200"
              : tone === "unknown"
                ? "text-amber-300"
                : tone === "lost"
                  ? "text-slate-400"
                  : "text-slate-300"
  );

  const statusConfidence = Math.max(
    0,
    Math.min(1, Number.isFinite(Number(statusInfo.confidence)) ? Number(statusInfo.confidence) : 0)
  );

  useEffect(() => {
    const previousTone = statusToneMemoryRef.current;
    if (previousTone === statusTone) {
      return;
    }

    statusToneMemoryRef.current = statusTone;

    if (statusTone === "switching") {
      switchingDelayJitterRef.current = Math.round(
        randomBetween(-SWITCHING_DELAY_JITTER_MS, SWITCHING_DELAY_JITTER_MS)
      );
    }

    if (statusTone === "locked" || statusTone === "identified") {
      identityRevealDelayRef.current = Math.round(
        randomBetween(IDENTITY_REVEAL_DELAY_MIN_MS, IDENTITY_REVEAL_DELAY_MAX_MS)
      );
    }

    confidenceBoostRef.current = ["looking", "recognizing", "switching", "locked", "identified"].includes(statusTone)
      ? Number(randomBetween(0.05, 0.1).toFixed(3))
      : 0;
  }, [statusTone]);

  useEffect(() => {
    if (statusTransitionTimerRef.current) {
      window.clearTimeout(statusTransitionTimerRef.current);
    }

    const switchingDelayMs = clamp(
      SWITCHING_DELAY_BASE_MS + switchingDelayJitterRef.current,
      80,
      300
    );

    const delayMs = ["identified", "locked"].includes(statusTone)
      ? 220
      : statusTone === "recognizing"
        ? 190
        : statusTone === "switching"
          ? switchingDelayMs
          : 120;

    const targetDisplayConfidence = clamp(
      statusConfidence
      + (
        ["looking", "recognizing", "switching", "locked", "identified"].includes(statusTone)
          ? confidenceBoostRef.current
          : 0
      ),
      0,
      1
    );

    statusTransitionTimerRef.current = window.setTimeout(() => {
      setStatusDisplay((previous) => {
        const confidenceDelta = Math.abs(Number(previous.confidence || 0) - targetDisplayConfidence);
        const hasMeaningfulChange =
          previous.type !== statusTone
          || previous.text !== statusText
          || previous.identityName !== statusIdentity
          || confidenceDelta >= 0.03;

        if (!hasMeaningfulChange) {
          return {
            ...previous,
            confidence: targetDisplayConfidence,
          };
        }

        return {
          key: previous.key + 1,
          type: statusTone,
          text: statusText,
          confidence: targetDisplayConfidence,
          identityName: statusIdentity,
        };
      });
    }, delayMs);

    return () => {
      if (statusTransitionTimerRef.current) {
        window.clearTimeout(statusTransitionTimerRef.current);
      }
    };
  }, [statusConfidence, statusIdentity, statusText, statusTone]);

  useEffect(() => {
    if (peakHoldTimerRef.current) {
      window.clearTimeout(peakHoldTimerRef.current);
    }

    const shouldPeakHold = statusDisplay.type === "recognizing" && statusDisplay.confidence >= 0.9;
    if (!shouldPeakHold) {
      peakHoldActiveRef.current = false;
      setPreConfirmHold(false);
      return undefined;
    }

    if (!peakHoldActiveRef.current) {
      peakHoldActiveRef.current = true;
      setPreConfirmHold(true);
      peakHoldTimerRef.current = window.setTimeout(() => {
        setPreConfirmHold(false);
      }, 150);
    }

    return () => {
      if (peakHoldTimerRef.current) {
        window.clearTimeout(peakHoldTimerRef.current);
      }
    };
  }, [statusDisplay.confidence, statusDisplay.type]);

  useEffect(() => {
    if (identityTransitionTimerRef.current) {
      window.clearTimeout(identityTransitionTimerRef.current);
    }

    const isLockedPhase = statusDisplay.type === "locked" || statusDisplay.type === "identified";
    const nextName = String(statusDisplay.identityName || "").trim();

    if (!isLockedPhase || !nextName) {
      setIdentityDisplay((previous) => ({
        ...previous,
        visible: false,
      }));
      return undefined;
    }

    const identityChanged = lastIdentityRef.current !== nextName;

    if (identityChanged) {
      lastIdentityRef.current = nextName;
      setIdentityDisplay((previous) => ({
        key: previous.key + 1,
        name: nextName,
        visible: false,
      }));

      if (confirmationPulseTimerRef.current) {
        window.clearTimeout(confirmationPulseTimerRef.current);
      }

      setConfirmationPulseActive(true);
      confirmationPulseTimerRef.current = window.setTimeout(() => {
        setConfirmationPulseActive(false);
      }, 220);

      playLockCue();
    }

    identityTransitionTimerRef.current = window.setTimeout(() => {
      setIdentityDisplay((previous) => ({
        ...previous,
        name: nextName,
        visible: true,
      }));
    }, identityRevealDelayRef.current);

    return () => {
      if (identityTransitionTimerRef.current) {
        window.clearTimeout(identityTransitionTimerRef.current);
      }
    };
  }, [playLockCue, statusDisplay.identityName, statusDisplay.type]);

  useEffect(() => {
    if (statusHoldTimerRef.current) {
      window.clearTimeout(statusHoldTimerRef.current);
    }

    if (statusDisplay.type === "lost") {
      statusHoldTimerRef.current = window.setTimeout(() => {
        setFocusTarget((previous) => ({
          ...previous,
          visible: false,
        }));
      }, 420);
    }

    return () => {
      if (statusHoldTimerRef.current) {
        window.clearTimeout(statusHoldTimerRef.current);
      }
    };
  }, [statusDisplay.type]);

  useEffect(() => {
    const phase = statusDisplay.type === "switching"
      ? "switching"
      : statusDisplay.type === "recognizing"
        ? "recognizing"
        : "idle";
    const anticipating = phase === "recognizing" && statusDisplay.confidence >= 0.85;
    const previousPhase = scanPhaseRef.current;
    const phaseChanged = previousPhase !== phase;
    const anticipationChanged = anticipating !== anticipationFlagRef.current;

    scanPhaseRef.current = phase;

    if (phase !== "recognizing" && phase !== "switching") {
      anticipationFlagRef.current = false;
      return;
    }

    if (phaseChanged || anticipationChanged) {
      anticipationFlagRef.current = anticipating;
      refreshOrganicCycleProfile(phase, Number(statusDisplay.confidence || 0));
      return;
    }

    const currentCycle = organicCycleRef.current;
    if (!currentCycle || !Number.isFinite(Number(currentCycle.scanDurationSec))) {
      refreshOrganicCycleProfile(phase, Number(statusDisplay.confidence || 0));
    }
  }, [refreshOrganicCycleProfile, statusDisplay.confidence, statusDisplay.type]);

  useEffect(() => () => {
    if (statusTransitionTimerRef.current) {
      window.clearTimeout(statusTransitionTimerRef.current);
    }
    if (identityTransitionTimerRef.current) {
      window.clearTimeout(identityTransitionTimerRef.current);
    }
    if (statusHoldTimerRef.current) {
      window.clearTimeout(statusHoldTimerRef.current);
    }
    if (confirmationPulseTimerRef.current) {
      window.clearTimeout(confirmationPulseTimerRef.current);
    }
    if (peakHoldTimerRef.current) {
      window.clearTimeout(peakHoldTimerRef.current);
    }
  }, []);

  const displayOpacity = Number(
    clamp(statusDisplay.confidence * 0.62 + 0.34, 0.35, 1).toFixed(3)
  );

  const confidenceBand =
    statusDisplay.confidence >= 0.9
      ? "peak"
      : statusDisplay.confidence >= 0.7
        ? "high"
        : statusDisplay.confidence >= 0.4
          ? "mid"
          : "low";

  const ritualText =
    statusDisplay.type === "recognizing"
      ? "Scanning face..."
      : statusDisplay.type === "switching"
        ? "Re-evaluating..."
        : statusDisplay.type === "locked" || statusDisplay.type === "identified"
          ? "Verified"
          : statusDisplay.type === "lost"
            ? "Face lost"
            : statusDisplay.type === "looking"
              ? "Focus on camera"
              : statusDisplay.text || "No face detected";

  const attentionPhase =
    statusDisplay.type === "identified"
      ? "locked"
      : statusDisplay.type === "idle"
        ? (focusTarget.phase || "idle")
        : statusDisplay.type;

  const attentionActive = ["looking", "recognizing", "locked", "switching", "identified", "lost"].includes(
    attentionPhase
  );
  const isAnticipatingLock = attentionPhase === "recognizing" && statusDisplay.confidence >= 0.85;

  const baseFocusScale =
    attentionPhase === "lost"
      ? 1.08
      : confidenceBand === "peak"
        ? 0.92
        : confidenceBand === "high"
          ? 0.96
          : confidenceBand === "mid"
            ? 1
            : 1.03;
  const anticipationTightenFactor = isAnticipatingLock ? 0.975 : 1;
  const focusScale = Number((baseFocusScale * anticipationTightenFactor).toFixed(3));
  const organicCycle = organicCycleRef.current;

  const focusStyle = {
    left: `${(focusTarget.centerXPct * 100).toFixed(2)}%`,
    top: `${(focusTarget.centerYPct * 100).toFixed(2)}%`,
    width: `${(focusTarget.sizePct * 100).toFixed(2)}%`,
    height: `${(focusTarget.sizePct * 100).toFixed(2)}%`,
    "--focus-base-scale": Number(focusScale).toFixed(3),
    "--focus-pulse-scale": Number(focusScale * 1.08).toFixed(3),
    transform: "translate(-50%, -50%) scale(var(--focus-base-scale))",
    "--scan-duration": `${organicCycle.scanDurationSec}s`,
    "--ring-thickness": `${organicCycle.ringThicknessPx}px`,
    "--focus-glow-intensity": String(organicCycle.glowIntensity),
    "--beam-duration": `${organicCycle.beamDurationSec}s`,
    "--scan-jitter-offset": `${organicCycle.jitterOffsetSec}s`,
    "--soft-ring-opacity": String(organicCycle.softOpacity),
    "--ring-eccentricity": String(organicCycle.eccentricity),
  };

  const stageStatusClass =
    attentionPhase === "locked"
      ? "ring-2 ring-emerald-300/50 shadow-[0_0_38px_rgba(16,185,129,0.34)]"
      : attentionPhase === "switching"
        ? "ring-2 ring-amber-300/45 shadow-[0_0_30px_rgba(251,191,36,0.26)]"
        : attentionPhase === "recognizing"
          ? "ring-2 ring-cyan-300/38 shadow-[0_0_30px_rgba(34,211,238,0.24)]"
          : attentionPhase === "looking"
            ? "ring-1 ring-sky-300/35"
            : attentionPhase === "lost"
              ? "ring-1 ring-slate-300/25"
              : "";

  const statusDisplayToneClass = toneClass(attentionPhase || statusTone);
  const showFocusOverlay =
    !suspendProcessing
    && (
      focusTarget.visible
      || ["recognizing", "switching", "locked", "lost"].includes(attentionPhase)
    );
  const focusPhaseClass =
    attentionPhase === "locked"
      ? "phase-locked"
      : attentionPhase === "switching"
        ? "phase-switching"
        : attentionPhase === "recognizing"
          ? "phase-recognizing"
          : attentionPhase === "looking"
            ? "phase-looking"
            : attentionPhase === "lost"
              ? "phase-lost"
              : "phase-idle";
  const focusBandClass = `band-${confidenceBand}`;
  const streamScaleClass = attentionActive ? "scale-[1.05]" : "scale-100";
  const shouldPauseScan = preConfirmHold && attentionPhase === "recognizing";
  const shouldFreezeRing = attentionPhase === "locked";
  const showIdleBreathing =
    !suspendProcessing
    && !focusTarget.visible
    && ["idle", "unknown", "lost"].includes(attentionPhase);
  const shouldShowIdentity =
    identityDisplay.visible
    && Boolean(identityDisplay.name)
    && (attentionPhase === "locked" || attentionPhase === "identified");
  const confidencePct = Math.round(clamp(statusDisplay.confidence, 0, 1) * 100);
  const bottomStatusText =
    attentionPhase === "recognizing"
      ? `Scanning confidence ${confidencePct}%`
      : attentionPhase === "locked"
        ? `Verified ${confidencePct}%`
        : attentionPhase === "switching"
          ? "Re-evaluating..."
          : attentionPhase === "lost"
            ? "Face lost"
            : ritualText;
  const stageDimOpacity = attentionActive
    ? (attentionPhase === "locked" ? 0.34 : 0.28)
    : 0;

  if (!isActive && !isMjpegSource) {
    return (
      <motion.article
        whileHover={{ y: -2 }}
        whileTap={{ scale: 0.997 }}
        className="glass-card group rounded-2xl border border-white/10 bg-white/[0.05] p-3 transition-all duration-300 hover:border-cyan-300/45 hover:shadow-neon-soft"
      >
        <div className="relative h-[240px] overflow-hidden rounded-2xl border border-white/10 bg-[#080D14]">
          <div className="absolute left-3 top-3 z-20 flex items-center gap-2 rounded-full bg-black/45 px-2 py-1 text-xs text-slate-100">
            <span className="h-2 w-2 rounded-full bg-slate-500" />
            {cameraLabel}
          </div>
          <div className="absolute right-3 top-3 z-20 rounded-full bg-slate-500/20 px-2 py-1 text-[11px] font-semibold uppercase tracking-widest text-slate-300">
            Offline
          </div>

          <div className="absolute inset-0 grid place-items-center text-sm text-slate-300">
            Camera Offline
          </div>

          <div className="absolute bottom-0 left-0 right-0 z-20 border-t border-white/10 bg-black/40 px-3 py-2 text-xs text-slate-300">
            No face detected
          </div>
        </div>

        {onRemove ? (
          <button type="button" className="neon-btn mt-3 w-full justify-center" onClick={onRemove}>
            Remove
          </button>
        ) : null}
      </motion.article>
    );
  }

  return (
    <motion.article
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.997 }}
      className="glass-card group rounded-2xl border border-white/10 bg-white/[0.05] p-3 transition-all duration-300 hover:-translate-y-0.5 hover:border-cyan-300/55 hover:shadow-neon"
    >
      <div
        ref={stageRef}
        className={`relative h-[240px] overflow-hidden rounded-2xl border border-white/10 bg-[#050A12] transition-all duration-300 ${stageStatusClass}`}
      >
        {isMjpegSource ? (
          <img
            ref={visibleMjpegRef}
            src={suspendProcessing ? "" : proxiedStreamUrl}
            alt={`${cameraLabel} MJPEG stream`}
            className={`h-full w-full object-cover transition-transform duration-500 ease-out will-change-transform group-hover:scale-[1.03] ${streamScaleClass}`}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
            onError={handleMjpegError}
            onLoad={handleMjpegLoad}
          />
        ) : (
          <video
            ref={videoRef}
            className={`h-full w-full object-cover transition-transform duration-500 ease-out will-change-transform group-hover:scale-[1.03] ${streamScaleClass}`}
            playsInline
            muted
            autoPlay
          />
        )}

        <canvas ref={overlayCanvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />

        <div className="pointer-events-none absolute inset-0 z-10 bg-gradient-to-b from-transparent via-transparent to-black/40" />
        <div
          className="pointer-events-none absolute inset-0 z-[11] bg-[#02050b] transition-opacity duration-500 ease-out"
          style={{ opacity: stageDimOpacity }}
        />

        <AnimatePresence>
          {showIdleBreathing ? (
            <motion.div
              key={`idle-breath-${cameraId}`}
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 1.03 }}
              transition={{ duration: 0.42, ease: "easeOut" }}
              className="perception-idle-breath pointer-events-none absolute inset-0 z-[16] grid place-items-center"
            >
              <span className="perception-idle-breath-ring" />
              <span className="perception-idle-breath-core" />
            </motion.div>
          ) : null}
        </AnimatePresence>

        <AnimatePresence>
          {showFocusOverlay ? (
            <motion.div
              key={`focus-shell-${cameraId}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, scale: 1.08 }}
              transition={{ duration: 0.28, ease: "easeOut" }}
              ref={focusShellRef}
              className={`perception-focus-shell pointer-events-none absolute z-20 ${focusPhaseClass} ${focusBandClass} ${shouldPauseScan ? "is-paused" : ""} ${shouldFreezeRing ? "is-frozen" : ""} ${confirmationPulseActive ? "is-confirm-pulse" : ""} ${isAnticipatingLock ? "is-anticipating" : ""}`}
              style={focusStyle}
            >
              <span className="perception-focus-grid" />
              <span className="perception-focus-ring" onAnimationIteration={handleScanRingIteration} />
              <span className="perception-focus-ring perception-focus-ring--soft" />
            </motion.div>
          ) : null}
        </AnimatePresence>

        {!suspendProcessing && (attentionPhase === "recognizing" || attentionPhase === "switching") ? (
          <div className="perception-scan-beam pointer-events-none absolute left-0 right-0 top-0 z-20 h-[2px]" />
        ) : null}

        {suspendProcessing ? (
          <div className="absolute inset-0 z-30 grid place-items-center bg-black/45 text-xs uppercase tracking-[0.14em] text-cyan-100">
            Face Registration In Progress
          </div>
        ) : null}

        {isMjpegSource && isConnecting ? (
          <div className="absolute inset-0 z-30 grid place-items-center bg-black/45 text-sm text-cyan-100">
            <div className="space-y-2 text-center">
              <div className="mx-auto h-7 w-7 rounded-full border-2 border-cyan-300/30 border-t-cyan-200 animate-spin" />
              <p>Connecting to camera...</p>
            </div>
          </div>
        ) : null}

        {isMjpegSource && connectionError ? (
          <div className="absolute bottom-3 left-3 right-3 z-30 rounded-xl border border-red-300/30 bg-red-500/10 p-3">
            <pre className="mb-2 whitespace-pre-wrap text-xs text-red-200">{connectionError}</pre>
            <button type="button" className="neon-btn text-xs" onClick={retryMjpegConnection}>
              Retry
            </button>
          </div>
        ) : null}

        <div className="absolute left-3 top-3 z-20 flex items-center gap-2 rounded-full bg-black/45 px-2 py-1 text-xs text-slate-100">
          <span className="h-2 w-2 rounded-full bg-emerald-300 shadow-[0_0_12px_rgba(74,222,128,0.95)] animate-pulse-dot" />
          {cameraLabel}
        </div>

        <div className="absolute right-3 top-3 z-20 rounded-full bg-emerald-500/20 px-2 py-1 text-[11px] font-semibold uppercase tracking-widest text-emerald-200">
          {stateLabel}
        </div>

        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center">
          <div className="flex min-h-[84px] flex-col items-center justify-center gap-2">
            <AnimatePresence mode="wait">
              <motion.p
                key={`center-status-${statusDisplay.key}-${ritualText}`}
                initial={{ opacity: 0, y: 8, scale: 0.96 }}
                animate={{
                  opacity: displayOpacity,
                  y: 0,
                  scale: attentionPhase === "locked" ? 1.03 : 1,
                }}
                exit={{ opacity: 0, y: -6, transition: { duration: attentionPhase === "lost" ? 0.5 : 0.2 } }}
                transition={{ duration: 0.24, ease: "easeOut" }}
                className={`rounded-full bg-black/45 px-3 py-1 text-xs tracking-[0.06em] ${statusDisplayToneClass}`}
              >
                {ritualText}
              </motion.p>
            </AnimatePresence>

            <AnimatePresence mode="wait">
              {shouldShowIdentity ? (
                <motion.p
                  key={`identity-name-${identityDisplay.key}-${identityDisplay.name}`}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 0.96, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.28, ease: "easeOut" }}
                  className="rounded-full border border-emerald-300/35 bg-emerald-500/12 px-3 py-1 text-sm font-semibold tracking-wide text-emerald-100 shadow-[0_0_24px_rgba(16,185,129,0.28)]"
                >
                  {identityDisplay.name}
                </motion.p>
              ) : null}
            </AnimatePresence>
          </div>
        </div>

        <div className="absolute bottom-0 left-0 right-0 z-20 flex items-center justify-between border-t border-white/10 bg-black/45 px-3 py-2">
          <AnimatePresence mode="wait">
            <motion.p
              key={`bottom-status-${statusDisplay.key}-${bottomStatusText}`}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: displayOpacity, x: 0 }}
              exit={{ opacity: 0, x: 8, transition: { duration: attentionPhase === "lost" ? 0.5 : 0.2 } }}
              transition={{ duration: 0.22, ease: "easeOut" }}
              className={`text-xs tracking-wide ${statusDisplayToneClass}`}
            >
              {bottomStatusText}
            </motion.p>
          </AnimatePresence>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-lg border border-cyan-300/40 bg-cyan-500/10 px-2 py-1 text-[11px] font-semibold text-cyan-100 transition hover:bg-cyan-400/20"
              onClick={handleToggleFullscreen}
            >
              Fullscreen
            </button>
            {onRemove ? (
              <button
                type="button"
                className="rounded-lg border border-red-300/40 bg-red-500/10 px-2 py-1 text-[11px] font-semibold text-red-100 transition hover:bg-red-500/25"
                onClick={onRemove}
              >
                Remove
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </motion.article>
  );
}
