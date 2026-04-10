import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { AnimatePresence, motion } from "framer-motion";
import FaceCaptureOverlay from "./FaceCaptureOverlay";
import { getFaceEngine } from "../lib/faceEngineLoader";
import { getAuthHeaders } from "../lib/securityHeaders";

const STORAGE_KEY = "omni:registry:v2";
const LEGACY_STORAGE_KEY = "omni:faces:v1";
const ENGINE_STORAGE_KEY = "omni_face_registry";
const CAMERA_STORAGE_KEY = "omni:cameras:v2";
const MAX_FACE_PHOTOS = 5;
const MAX_MERGED_PHOTOS = 30;
const MAX_MERGED_DESCRIPTORS = 30;
const API_BASE =
  import.meta.env.VITE_BACKEND_URL ||
  import.meta.env.VITE_API_BASE ||
  "http://localhost:5000";

const PROGRAM_OPTIONS = [
  "B.Tech CSE",
  "B.Tech ECE",
  "B.Tech ME",
  "MBA",
  "MCA",
  "B.Sc Physics",
  "MBBS",
  "B.Arch",
  "B.Com",
  "BBA",
];

const YEAR_OPTIONS = ["1", "2", "3", "4"];

const EMPTY_FORM = {
  fullName: "",
  studentId: "",
  program: PROGRAM_OPTIONS[0],
  year: "1",
  phone: "",
};

const MIN_SUCCESSFUL_DETECTIONS = 3;
const AUTO_CAPTURE_COUNTDOWN_SECONDS = 1;
const AUTO_CAPTURE_BURST_ATTEMPTS = 8;
const AUTO_CAPTURE_BURST_INTERVAL_MS = 90;
const AUTO_CAPTURE_STEPS = [
  "Look straight ahead",
  "Turn slightly left",
  "Turn slightly right",
  "Tilt head slightly up",
  "Look straight again",
];

const PHONE_WEBCAM_LABEL_REGEX = /iriun|droidcam|epoccam|camo/i;

function readPreferredWebcamDeviceId() {
  if (typeof window === "undefined") {
    return "";
  }

  try {
    const raw = localStorage.getItem(CAMERA_STORAGE_KEY);
    if (!raw) {
      return "";
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return "";
    }

    const localWebcams = parsed.filter(
      (camera) => String(camera?.source || "") === "laptop-webcam"
    );
    const preferred = localWebcams.find((camera) => String(camera?.deviceId || "").trim());

    return String(preferred?.deviceId || "").trim();
  } catch (error) {
    return "";
  }
}

function pickPreferredCaptureDeviceId(devices = [], preferredId = "") {
  if (!Array.isArray(devices) || devices.length === 0) {
    return "";
  }

  const exactPreferred = String(preferredId || "").trim();
  if (exactPreferred && devices.some((device) => device.deviceId === exactPreferred)) {
    return exactPreferred;
  }

  const iriunDevice = devices.find((device) => /iriun/i.test(String(device.label || "")));
  if (iriunDevice?.deviceId) {
    return iriunDevice.deviceId;
  }

  const phoneWebcam = devices.find((device) =>
    PHONE_WEBCAM_LABEL_REGEX.test(String(device.label || ""))
  );
  if (phoneWebcam?.deviceId) {
    return phoneWebcam.deviceId;
  }

  return String(devices[0]?.deviceId || "");
}

function euclideanDistance(a, b) {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let index = 0; index < len; index += 1) {
    const diff = Number(a[index] || 0) - Number(b[index] || 0);
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function buildConsistencyReport(descriptors = []) {
  if (!Array.isArray(descriptors) || descriptors.length < 2) {
    return null;
  }

  let totalDistance = 0;
  let comparisons = 0;

  for (let i = 0; i < descriptors.length; i += 1) {
    for (let j = i + 1; j < descriptors.length; j += 1) {
      totalDistance += euclideanDistance(descriptors[i], descriptors[j]);
      comparisons += 1;
    }
  }

  if (comparisons === 0) {
    return null;
  }

  const averageDistance = totalDistance / comparisons;
  const confidencePct = Math.round(clamp(((0.72 - averageDistance) / 0.42) * 100, 0, 100));

  let tone = "green";
  let label = "consistent (good)";

  if (averageDistance > 0.58) {
    tone = "red";
    label = "too varied (retake)";
  } else if (averageDistance > 0.42) {
    tone = "yellow";
    label = "varied (okay)";
  }

  return {
    averageDistance: Number(averageDistance.toFixed(4)),
    confidencePct,
    tone,
    label,
  };
}

function normalizeDescriptorArray(value) {
  if (!Array.isArray(value)) {
    return null;
  }

  const normalized = value
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry));

  return normalized.length > 0 ? normalized : null;
}

function averageDescriptorVectors(descriptors = []) {
  const normalizedDescriptors = (Array.isArray(descriptors) ? descriptors : [])
    .map((descriptor) => normalizeDescriptorArray(descriptor))
    .filter(Boolean);

  if (normalizedDescriptors.length === 0) {
    return [];
  }

  const minLength = Math.min(...normalizedDescriptors.map((descriptor) => descriptor.length));
  if (!Number.isFinite(minLength) || minLength <= 0) {
    return [];
  }

  const accumulator = new Array(minLength).fill(0);
  normalizedDescriptors.forEach((descriptor) => {
    for (let index = 0; index < minLength; index += 1) {
      accumulator[index] += Number(descriptor[index] || 0);
    }
  });

  return accumulator.map((value) => Number((value / normalizedDescriptors.length).toFixed(8)));
}

function normalizePhoto(entry, index) {
  const dataUrl = String(entry?.dataUrl || "");
  if (!dataUrl.startsWith("data:image/")) {
    return null;
  }

  return {
    id: String(entry?.id || `${Date.now()}-${index}`),
    dataUrl,
  };
}

function normalizeRecord(entry, index) {
  const studentId = String(entry?.studentId || "").trim();
  if (!studentId) {
    return null;
  }

  const fullName = String(entry?.fullName || entry?.name || "").trim() || "Unknown";
  const program = PROGRAM_OPTIONS.includes(entry?.program) ? entry.program : PROGRAM_OPTIONS[0];
  const year = YEAR_OPTIONS.includes(String(entry?.year || ""))
    ? String(entry.year)
    : "1";

  const photos = Array.isArray(entry?.photos)
    ? entry.photos.map(normalizePhoto).filter(Boolean).slice(-MAX_MERGED_PHOTOS)
    : [];

  const descriptors = Array.isArray(entry?.descriptors)
    ? entry.descriptors
        .map((item) => normalizeDescriptorArray(item))
        .filter(Boolean)
        .slice(-MAX_MERGED_DESCRIPTORS)
    : [];

  return {
    id: String(entry?.id || `${studentId}-${index}`),
    fullName,
    studentId,
    program,
    year,
    phone: String(entry?.phone || "").trim(),
    photos,
    descriptors,
    createdAt: entry?.createdAt || new Date().toISOString(),
    updatedAt: entry?.updatedAt || new Date().toISOString(),
  };
}

function readStoredRegistry() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed.map(normalizeRecord).filter(Boolean);
    }

    const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!legacyRaw) {
      return [];
    }

    const legacy = JSON.parse(legacyRaw);
    if (!Array.isArray(legacy)) {
      return [];
    }

    return legacy
      .map((entry) => {
        const studentId = String(entry?.personId || "").trim();
        if (!studentId) {
          return null;
        }

        const imageDataUrl = String(entry?.imageDataUrl || "");
        const photos = imageDataUrl.startsWith("data:image/")
          ? [{ id: `${studentId}-0`, dataUrl: imageDataUrl }]
          : [];

        return normalizeRecord({
          id: studentId,
          fullName: entry?.name || "Unknown",
          studentId,
          program: PROGRAM_OPTIONS[0],
          year: "1",
          phone: "",
          photos,
          descriptors: [],
        });
      })
      .filter(Boolean);
  } catch (error) {
    return [];
  }
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = dataUrl;
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function analyzeImageQuality(image) {
  if (typeof document === "undefined" || !image) {
    return {
      brightness: 0,
      contrast: 0,
      sharpness: 0,
    };
  }

  const canvas = document.createElement("canvas");
  const width = Math.max(1, Math.min(220, Number(image.naturalWidth || image.width || 220)));
  const height = Math.max(1, Math.min(220, Number(image.naturalHeight || image.height || 220)));
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    return {
      brightness: 0,
      contrast: 0,
      sharpness: 0,
    };
  }

  ctx.drawImage(image, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height).data;

  const totalPixels = width * height;
  if (totalPixels <= 0) {
    return {
      brightness: 0,
      contrast: 0,
      sharpness: 0,
    };
  }

  const grayscale = new Array(totalPixels);
  let brightnessSum = 0;

  for (let index = 0; index < totalPixels; index += 1) {
    const pixelIndex = index * 4;
    const r = imageData[pixelIndex];
    const g = imageData[pixelIndex + 1];
    const b = imageData[pixelIndex + 2];
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    grayscale[index] = gray;
    brightnessSum += gray;
  }

  const meanBrightness = brightnessSum / totalPixels;

  let varianceSum = 0;
  for (let index = 0; index < totalPixels; index += 1) {
    const diff = grayscale[index] - meanBrightness;
    varianceSum += diff * diff;
  }
  const contrast = Math.sqrt(varianceSum / totalPixels);

  let gradientSum = 0;
  let gradientCount = 0;
  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const idx = y * width + x;
      const gx = grayscale[idx + 1] - grayscale[idx];
      const gy = grayscale[idx + width] - grayscale[idx];
      gradientSum += Math.sqrt(gx * gx + gy * gy);
      gradientCount += 1;
    }
  }

  const sharpness = gradientCount > 0 ? gradientSum / gradientCount : 0;

  return {
    brightness: Number(meanBrightness.toFixed(2)),
    contrast: Number(contrast.toFixed(2)),
    sharpness: Number(sharpness.toFixed(2)),
  };
}

function statusFromStudentsMap(statusMap, studentId) {
  return statusMap.get(studentId) === "online" ? "online" : "offline";
}

function removeFromLocalRegistry(studentId) {
  const key = String(studentId || "").trim();
  if (!key) {
    return;
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const next = parsed.filter((entry) => String(entry?.studentId || "") !== key);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      }
    }
  } catch (error) {
    // Ignore storage errors so deletion can proceed.
  }

  try {
    const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacyRaw) {
      const parsed = JSON.parse(legacyRaw);
      if (Array.isArray(parsed)) {
        const next = parsed.filter((entry) => String(entry?.personId || "") !== key);
        localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(next));
      }
    }
  } catch (error) {
    // Ignore storage errors so deletion can proceed.
  }

  try {
    const engineRaw = localStorage.getItem(ENGINE_STORAGE_KEY);
    if (engineRaw) {
      const parsed = JSON.parse(engineRaw);
      if (Array.isArray(parsed)) {
        const next = parsed.filter((entry) => String(entry?.personId || "") !== key);
        localStorage.setItem(ENGINE_STORAGE_KEY, JSON.stringify(next));
      }
    }
  } catch (error) {
    // Ignore storage errors so deletion can proceed.
  }
}

function clearAllLocalRegistries() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    localStorage.removeItem(ENGINE_STORAGE_KEY);
  } catch (error) {
    // Ignore storage errors so clear-all flow can continue.
  }
}

function estimatePoseFromBox(box) {
  const width = Number(box?.width || 0);
  const height = Number(box?.height || 0);

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return {
      poseYaw: 0,
      posePitch: 0,
    };
  }

  const ratio = width / Math.max(1, height);
  const yaw = (ratio - 0.75) * 45;

  return {
    poseYaw: Number(Math.max(-45, Math.min(45, yaw)).toFixed(2)),
    posePitch: 0,
  };
}

function descriptorFingerprint(descriptor) {
  const normalized = normalizeDescriptorArray(descriptor);
  if (!normalized) {
    return "";
  }

  return normalized.map((value) => value.toFixed(6)).join("|");
}

function mergeDescriptors(existing = [], incoming = []) {
  const merged = [];
  const seen = new Set();

  const pushDescriptor = (descriptor) => {
    const normalized = normalizeDescriptorArray(descriptor);
    if (!normalized) {
      return;
    }

    const key = descriptorFingerprint(normalized);
    if (!key || seen.has(key)) {
      return;
    }

    seen.add(key);
    merged.push(normalized);
  };

  existing.forEach(pushDescriptor);
  incoming.forEach(pushDescriptor);

  return merged.slice(-MAX_MERGED_DESCRIPTORS);
}

function mergePhotos(existing = [], incoming = []) {
  const merged = [];
  const seen = new Set();

  const pushPhoto = (photo, index) => {
    const normalized = normalizePhoto(photo, index);
    if (!normalized) {
      return;
    }

    const key = normalized.dataUrl;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    merged.push(normalized);
  };

  existing.forEach((photo, index) => pushPhoto(photo, index));
  incoming.forEach((photo, index) => pushPhoto(photo, index));

  return merged.slice(-MAX_MERGED_PHOTOS);
}

export default function FaceRegister({
  open,
  onClose,
  students = [],
  onRegistrationSaved,
}) {
  const [registry, setRegistry] = useState(() => readStoredRegistry());
  const [mode, setMode] = useState("create");
  const [editingStudentId, setEditingStudentId] = useState("");
  const [form, setForm] = useState(EMPTY_FORM);
  const [draftPhotos, setDraftPhotos] = useState([]);
  const [draftDescriptors, setDraftDescriptors] = useState([]);
  const [previewUrl, setPreviewUrl] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [hydrating, setHydrating] = useState(true);
  const [busy, setBusy] = useState(false);
  const [captureCountdown, setCaptureCountdown] = useState(0);
  const [showWebcamPreview, setShowWebcamPreview] = useState(false);
  const [autoCaptureRunning, setAutoCaptureRunning] = useState(false);
  const [autoCaptureCompleted, setAutoCaptureCompleted] = useState(false);
  const [autoCaptureStepIndex, setAutoCaptureStepIndex] = useState(0);
  const [captureInstruction, setCaptureInstruction] = useState(AUTO_CAPTURE_STEPS[0]);
  const [autoCapturedCount, setAutoCapturedCount] = useState(0);
  const [captureFlash, setCaptureFlash] = useState(false);
  const [captureDevices, setCaptureDevices] = useState([]);
  const [captureDeviceId, setCaptureDeviceId] = useState(() => readPreferredWebcamDeviceId());
  const [draftDescriptorQuality, setDraftDescriptorQuality] = useState([]);
  const [uploadResults, setUploadResults] = useState([]);
  const [consistencyReport, setConsistencyReport] = useState(null);
  const [liveCaptureStarted, setLiveCaptureStarted] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const [showAdvancedMenu, setShowAdvancedMenu] = useState(false);
  const [registrationCompleted, setRegistrationCompleted] = useState(false);
  const [stepOneValidationTick, setStepOneValidationTick] = useState(0);

  const captureVideoRef = useRef(null);
  const captureStreamRef = useRef(null);
  const uploadInputRef = useRef(null);
  const importInputRef = useRef(null);
  const countdownTimerRef = useRef(null);
  const flashTimerRef = useRef(null);
  const autoCaptureAbortRef = useRef(false);
  const faceEngineRef = useRef(null);

  const ensureFaceEngine = useCallback(async () => {
    if (faceEngineRef.current) {
      return faceEngineRef.current;
    }

    const engine = await getFaceEngine();
    faceEngineRef.current = engine;
    return engine;
  }, []);

  const refreshCaptureDevices = useCallback(async ({ warmup = true } = {}) => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setCaptureDevices([]);
      return [];
    }

    try {
      let devices = await navigator.mediaDevices.enumerateDevices();
      let videoInputs = devices.filter((device) => device.kind === "videoinput");

      const labelsMissing =
        videoInputs.length === 0 || videoInputs.every((device) => !String(device.label || "").trim());
      if (warmup && labelsMissing && navigator.mediaDevices?.getUserMedia) {
        const warmupStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        warmupStream.getTracks().forEach((track) => track.stop());

        devices = await navigator.mediaDevices.enumerateDevices();
        videoInputs = devices.filter((device) => device.kind === "videoinput");
      }

      setCaptureDevices(videoInputs);
      setCaptureDeviceId((prev) => {
        const nextPreferred = pickPreferredCaptureDeviceId(
          videoInputs,
          prev || readPreferredWebcamDeviceId()
        );
        return nextPreferred || prev;
      });

      return videoInputs;
    } catch (error) {
      setCaptureDevices([]);
      return [];
    }
  }, []);

  const statusMap = useMemo(() => {
    const map = new Map();
    (students || []).forEach((student) => {
      map.set(student.studentId, student.status || "offline");
    });
    return map;
  }, [students]);

  const syncingEngineFromRegistry = useCallback(async (entries) => {
    const faceEngine = await ensureFaceEngine();
    await faceEngine.loadModels();
    faceEngine.clearAllPeople();

    entries.forEach((entry) => {
      if (Array.isArray(entry.descriptors) && entry.descriptors.length > 0) {
        faceEngine.setPersonDescriptors(entry.studentId, entry.fullName, entry.descriptors);
      }
    });
  }, [ensureFaceEngine]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(registry));
  }, [registry]);

  useEffect(() => {
    let cancelled = false;

    const hydrate = async () => {
      try {
        const faceEngine = await ensureFaceEngine();
        await faceEngine.loadModels();
        if (cancelled) {
          return;
        }

        const stored = readStoredRegistry();
        if (cancelled) {
          return;
        }

        setRegistry(stored);
        await syncingEngineFromRegistry(stored);

        if (!cancelled) {
          setHydrating(false);
          setError("");
        }
      } catch (hydrateError) {
        if (!cancelled) {
          setHydrating(false);
          setError("Unable to initialize face models.");
        }
      }
    };

    hydrate();

    return () => {
      cancelled = true;
    };
  }, [ensureFaceEngine, syncingEngineFromRegistry]);

  useEffect(() => {
    if (!open) {
      return;
    }

    setRegistry(readStoredRegistry());
  }, [open]);

  const stopCountdown = useCallback(() => {
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }

    setCaptureCountdown(0);
  }, []);

  const stopCamera = useCallback(() => {
    if (captureStreamRef.current) {
      captureStreamRef.current.getTracks().forEach((track) => track.stop());
      captureStreamRef.current = null;
    }
  }, []);

  const stopAutoCapture = useCallback(() => {
    autoCaptureAbortRef.current = true;
    setAutoCaptureRunning(false);
    setCaptureCountdown(0);
    setBusy(false);
  }, []);

  const bindCaptureStreamToVideo = useCallback(async (stream) => {
    const video = captureVideoRef.current;
    if (!video) {
      return false;
    }

    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;

    try {
      await video.play();
    } catch (error) {
      // Browsers may delay play until metadata is available.
    }

    if (video.readyState >= 2 && Number(video.videoWidth) > 0) {
      return true;
    }

    await new Promise((resolve) => {
      let resolved = false;

      const done = () => {
        if (resolved) {
          return;
        }

        resolved = true;
        video.removeEventListener("loadedmetadata", done);
        video.removeEventListener("canplay", done);
        video.removeEventListener("playing", done);
        resolve();
      };

      video.addEventListener("loadedmetadata", done, { once: true });
      video.addEventListener("canplay", done, { once: true });
      video.addEventListener("playing", done, { once: true });
      window.setTimeout(done, 1500);
    });

    return video.readyState >= 2 && Number(video.videoWidth) > 0;
  }, []);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current) {
        clearTimeout(flashTimerRef.current);
        flashTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!open || currentStep !== 2) {
      return;
    }

    void refreshCaptureDevices({ warmup: true });
  }, [currentStep, open, refreshCaptureDevices]);

  useEffect(() => {
    if (!open || !showWebcamPreview) {
      stopAutoCapture();
      stopCountdown();
      stopCamera();
      return undefined;
    }

    let cancelled = false;

    const startCaptureStream = async () => {
      try {
        const preferredFromStorage = readPreferredWebcamDeviceId();
        const devices = await refreshCaptureDevices({ warmup: false });
        const resolvedDeviceId = pickPreferredCaptureDeviceId(
          devices,
          captureDeviceId || preferredFromStorage
        );

        if (resolvedDeviceId && resolvedDeviceId !== captureDeviceId) {
          setCaptureDeviceId(resolvedDeviceId);
        }

        const preferredConstraints = resolvedDeviceId
          ? {
              video: {
                deviceId: { exact: resolvedDeviceId },
                width: { ideal: 1280 },
                height: { ideal: 720 },
              },
              audio: false,
            }
          : {
              video: {
                width: { ideal: 1280 },
                height: { ideal: 720 },
              },
              audio: false,
            };

        let stream;
        try {
          stream = await navigator.mediaDevices.getUserMedia(preferredConstraints);
        } catch (preferredError) {
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        }

        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        captureStreamRef.current = stream;
        const activeDeviceId = stream.getVideoTracks()[0]?.getSettings?.().deviceId || "";
        if (activeDeviceId && activeDeviceId !== captureDeviceId) {
          setCaptureDeviceId(activeDeviceId);
        }

        await bindCaptureStreamToVideo(stream);
        setError("");
      } catch (streamError) {
        if (!cancelled) {
          setError("Unable to access webcam for live capture.");
        }
      }
    };

    void startCaptureStream();

    return () => {
      cancelled = true;
      stopAutoCapture();
      stopCountdown();
      stopCamera();
    };
  }, [
    bindCaptureStreamToVideo,
    captureDeviceId,
    open,
    refreshCaptureDevices,
    showWebcamPreview,
    stopAutoCapture,
    stopCamera,
    stopCountdown,
  ]);

  const resetEditor = useCallback(() => {
    autoCaptureAbortRef.current = true;
    stopCountdown();
    if (flashTimerRef.current) {
      clearTimeout(flashTimerRef.current);
      flashTimerRef.current = null;
    }
    setMode("create");
    setEditingStudentId("");
    setForm(EMPTY_FORM);
    setDraftPhotos([]);
    setDraftDescriptors([]);
    setDraftDescriptorQuality([]);
    setPreviewUrl("");
    setUploadResults([]);
    setShowWebcamPreview(false);
    setAutoCaptureRunning(false);
    setAutoCaptureCompleted(false);
    setAutoCaptureStepIndex(0);
    setCaptureInstruction(AUTO_CAPTURE_STEPS[0]);
    setAutoCapturedCount(0);
    setCaptureFlash(false);
    setConsistencyReport(null);
    setLiveCaptureStarted(false);
    setCurrentStep(1);
    setShowAdvancedMenu(false);
    setRegistrationCompleted(false);
    setError("");
    setSuccess("");
  }, [stopCountdown]);

  const closeModal = useCallback(() => {
    autoCaptureAbortRef.current = true;
    void syncingEngineFromRegistry(registry);
    resetEditor();
    setBusy(false);
    onClose?.();
  }, [onClose, registry, resetEditor, syncingEngineFromRegistry]);

  const openEditor = useCallback((record, nextMode) => {
    autoCaptureAbortRef.current = true;
    setMode(nextMode);
    setEditingStudentId(record.studentId);
    setForm({
      fullName: record.fullName,
      studentId: record.studentId,
      program: record.program,
      year: String(record.year),
      phone: record.phone || "",
    });
    setDraftPhotos(Array.isArray(record.photos) ? record.photos : []);
    setDraftDescriptors(Array.isArray(record.descriptors) ? record.descriptors : []);
    setDraftDescriptorQuality([]);
    setPreviewUrl(record.photos?.[record.photos.length - 1]?.dataUrl || "");
    setUploadResults([]);
    setShowWebcamPreview(false);
    setAutoCaptureRunning(false);
    setAutoCaptureCompleted(false);
    setAutoCaptureStepIndex(0);
    setCaptureInstruction(AUTO_CAPTURE_STEPS[0]);
    setAutoCapturedCount(0);
    setCaptureFlash(false);
    setConsistencyReport(null);
    setLiveCaptureStarted(false);
    setError("");
    setSuccess("");
  }, []);

  const formIsPhotoOnly = mode === "photos";
  const validateCapturePrerequisites = useCallback(() => {
    const studentId = String(form.studentId || "").trim();
    const fullName = String(form.fullName || "").trim();

    if (!studentId || !fullName) {
      setError("Enter Full Name and Student ID before adding face photos.");
      return false;
    }

    if (hydrating) {
      setError("Face model is loading. Please wait a moment.");
      return false;
    }

    return true;
  }, [form.fullName, form.studentId, hydrating]);

  const appendCapturedPhoto = useCallback(
    (dataUrl, descriptor, explicitCount = null, quality = null) => {
      const studentId = String(form.studentId || "").trim() || "student";
      const photoId = `${studentId}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
      const nextPhoto = { id: photoId, dataUrl };

      setDraftPhotos((prev) => [...prev, nextPhoto].slice(0, MAX_FACE_PHOTOS));
      setDraftDescriptors((prev) => [...prev, descriptor].slice(0, MAX_FACE_PHOTOS));
      setDraftDescriptorQuality((prev) => [...prev, quality].slice(0, MAX_FACE_PHOTOS));
      setPreviewUrl(dataUrl);

      const nextCount = Number.isFinite(Number(explicitCount))
        ? Number(explicitCount)
        : Math.min(draftPhotos.length + 1, MAX_FACE_PHOTOS);
      setSuccess(`Face photo added (${nextCount}/${MAX_FACE_PHOTOS}).`);
    },
    [draftPhotos.length, form.studentId]
  );

  const extractDescriptorFromDataUrl = useCallback(async (dataUrl, detectorOptions = {}) => {
    try {
      const image = await loadImage(dataUrl);
      const faceEngine = await ensureFaceEngine();
      const result = await faceEngine.extractFaceDescriptor(image, {
        inputSize: Number(detectorOptions.inputSize) > 0
          ? Number(detectorOptions.inputSize)
          : 320,
        scoreThreshold: Number.isFinite(Number(detectorOptions.scoreThreshold))
          ? Number(detectorOptions.scoreThreshold)
          : 0.25,
        minConfidence: Number.isFinite(Number(detectorOptions.minConfidence))
          ? Number(detectorOptions.minConfidence)
          : 0.25,
      });

      const descriptor = normalizeDescriptorArray(result?.descriptor);
      if (!descriptor) {
        return {
          ok: false,
          reason: "Face not detected clearly - please try again",
        };
      }

      const qualityFromImage = analyzeImageQuality(image);
      const pose = estimatePoseFromBox(result?.box);

      return {
        ok: true,
        descriptor,
        quality: {
          ...qualityFromImage,
          ...pose,
          detectionScore: Number(result?.score || 0),
          detector: String(result?.detector || "unknown"),
        },
      };
    } catch (captureError) {
      return {
        ok: false,
        reason: "Failed to process face photo.",
      };
    }
  }, [ensureFaceEngine]);

  const extractDescriptorFromVideo = useCallback(async (detectorOptions = {}) => {
    try {
      const video = captureVideoRef.current;
      if (!video || video.readyState < 2 || Number(video.videoWidth) <= 0) {
        return {
          ok: false,
          reason: "Webcam is not ready yet.",
        };
      }

      const faceEngine = await ensureFaceEngine();
      const result = await faceEngine.extractFaceDescriptor(video, {
        inputSize: Number(detectorOptions.inputSize) > 0
          ? Number(detectorOptions.inputSize)
          : 416,
        scoreThreshold: Number.isFinite(Number(detectorOptions.scoreThreshold))
          ? Number(detectorOptions.scoreThreshold)
          : 0.12,
        minConfidence: Number.isFinite(Number(detectorOptions.minConfidence))
          ? Number(detectorOptions.minConfidence)
          : 0.18,
      });

      const descriptor = normalizeDescriptorArray(result?.descriptor);
      if (!descriptor) {
        return {
          ok: false,
          reason: "Face not detected clearly - please try again",
        };
      }

      return {
        ok: true,
        descriptor,
        detectionScore: Number(result?.score || 0),
        box: result?.box || null,
        detector: String(result?.detector || "unknown"),
      };
    } catch (captureError) {
      return {
        ok: false,
        reason: "Face not detected clearly - please try again",
      };
    }
  }, [ensureFaceEngine]);

  const captureFrameDataUrl = useCallback(() => {
    const video = captureVideoRef.current;
    if (!video || video.readyState < 2) {
      return "";
    }

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return "";
    }

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.92);
  }, []);

  const captureBestFaceBurst = useCallback(async () => {
    const candidates = [];

    for (
      let attempt = 0;
      attempt < AUTO_CAPTURE_BURST_ATTEMPTS && !autoCaptureAbortRef.current;
      attempt += 1
    ) {
      const extraction = await extractDescriptorFromVideo({
        inputSize: 416,
        scoreThreshold: 0.12,
        minConfidence: 0.18,
      });

      if (extraction.ok) {
        const dataUrl = captureFrameDataUrl();
        if (dataUrl) {
          const video = captureVideoRef.current;
          const videoArea = Math.max(1, Number(video?.videoWidth || 1) * Number(video?.videoHeight || 1));
          const boxWidth = Number(extraction.box?.width || 0);
          const boxHeight = Number(extraction.box?.height || 0);
          const areaRatio = Math.max(0, Math.min(1, (boxWidth * boxHeight) / videoArea));
          const rank = Number(extraction.detectionScore || 0) * 100 + areaRatio * 35;

          candidates.push({
            dataUrl,
            descriptor: extraction.descriptor,
            detectionScore: Number(extraction.detectionScore || 0),
            detector: extraction.detector,
            box: extraction.box,
            rank,
          });

          if (rank >= 62) {
            break;
          }
        }
      }

      await new Promise((resolve) => {
        window.setTimeout(resolve, AUTO_CAPTURE_BURST_INTERVAL_MS);
      });
    }

    if (candidates.length === 0) {
      return {
        ok: false,
        reason: "Face not detected clearly - please try again",
      };
    }

    const best = candidates.reduce((acc, current) => (current.rank > acc.rank ? current : acc));

    try {
      const image = await loadImage(best.dataUrl);
      const qualityFromImage = analyzeImageQuality(image);
      const pose = estimatePoseFromBox(best.box);

      return {
        ok: true,
        dataUrl: best.dataUrl,
        descriptor: best.descriptor,
        quality: {
          ...qualityFromImage,
          ...pose,
          detectionScore: best.detectionScore,
          detector: best.detector,
        },
      };
    } catch (qualityError) {
      return {
        ok: true,
        dataUrl: best.dataUrl,
        descriptor: best.descriptor,
        quality: {
          brightness: 0,
          contrast: 0,
          sharpness: 0,
          poseYaw: 0,
          posePitch: 0,
          detectionScore: best.detectionScore,
          detector: best.detector,
        },
      };
    }
  }, [captureFrameDataUrl, extractDescriptorFromVideo]);

  const waitForVideoReady = useCallback(async (timeoutMs = 12000) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const video = captureVideoRef.current;
      if (
        video
        && video.srcObject
        && video.readyState >= 2
        && Number(video.videoWidth) > 0
      ) {
        return true;
      }

      try {
        await video?.play?.();
      } catch (error) {
        // Ignore and continue polling until timeout.
      }

      await new Promise((resolve) => window.setTimeout(resolve, 150));
    }

    return false;
  }, []);

  const triggerCaptureFlash = useCallback(() => {
    setCaptureFlash(true);
    if (flashTimerRef.current) {
      clearTimeout(flashTimerRef.current);
    }

    flashTimerRef.current = setTimeout(() => {
      setCaptureFlash(false);
      flashTimerRef.current = null;
    }, 160);
  }, []);

  const onUploadFiles = useCallback(
    async (files) => {
      const list = Array.from(files || []);
      if (list.length === 0) {
        return;
      }

      if (!validateCapturePrerequisites()) {
        return;
      }

      const supported = list.filter(
        (file) => file.type === "image/jpeg" || file.type === "image/png"
      );

      if (supported.length === 0) {
        setError("Only JPG and PNG files are supported.");
        return;
      }

      const availableSlots = Math.max(0, MAX_FACE_PHOTOS - draftPhotos.length);
      if (availableSlots <= 0) {
        setError(`Maximum ${MAX_FACE_PHOTOS} photos are allowed per person.`);
        return;
      }

      const filesToProcess = supported.slice(0, availableSlots);
      const results = [];
      let successCount = 0;

      setBusy(true);
      setError("");
      setSuccess("");
      setUploadResults([]);

      for (const file of filesToProcess) {
        try {
          const dataUrl = await readFileAsDataUrl(file);
          const extraction = await extractDescriptorFromDataUrl(dataUrl);
          if (!extraction.ok) {
            results.push({ name: file.name, success: false, reason: extraction.reason });
            continue;
          }

          successCount += 1;
          appendCapturedPhoto(
            dataUrl,
            extraction.descriptor,
            draftPhotos.length + successCount,
            extraction.quality || null
          );
          results.push({ name: file.name, success: true });
        } catch (uploadError) {
          results.push({ name: file.name, success: false, reason: "Failed to read file." });
        }
      }

      setUploadResults(results);
      setBusy(false);

      if (successCount === 0) {
        setError("Face not detected clearly - please try again");
        return;
      }

      if (successCount < MIN_SUCCESSFUL_DETECTIONS && draftDescriptors.length + successCount < MIN_SUCCESSFUL_DETECTIONS) {
        setError("At least 2 successful face detections are required before saving.");
      } else {
        setSuccess(`${successCount} photo(s) processed successfully.`);
      }
    },
    [
      appendCapturedPhoto,
      draftDescriptors.length,
      draftPhotos.length,
      extractDescriptorFromDataUrl,
      validateCapturePrerequisites,
    ]
  );

  const handleUploadInput = useCallback(
    async (event) => {
      await onUploadFiles(event.target.files);
      event.target.value = "";
    },
    [onUploadFiles]
  );

  const startAutoFaceCapture = useCallback(async () => {
    if (autoCaptureRunning || busy) {
      return;
    }

    if (!validateCapturePrerequisites()) {
      return;
    }

    autoCaptureAbortRef.current = false;
    setShowWebcamPreview(true);
    setLiveCaptureStarted(true);
    setAutoCaptureRunning(true);
    setAutoCaptureCompleted(false);
    setAutoCaptureStepIndex(0);
    setAutoCapturedCount(0);
    setCaptureInstruction(AUTO_CAPTURE_STEPS[0]);
    setDraftPhotos([]);
    setDraftDescriptors([]);
    setUploadResults([]);
    setError("");
    setSuccess("");
    setBusy(true);

    let ready = await waitForVideoReady(12000);
    if (!ready && !autoCaptureAbortRef.current) {
      if (captureStreamRef.current) {
        await bindCaptureStreamToVideo(captureStreamRef.current);
      }
      ready = await waitForVideoReady(5000);
    }

    if (!ready || autoCaptureAbortRef.current) {
      setAutoCaptureRunning(false);
      setBusy(false);
      setError("Webcam is not ready yet.");
      return;
    }

    let stepIndex = 0;
    while (stepIndex < AUTO_CAPTURE_STEPS.length && !autoCaptureAbortRef.current) {
      setAutoCaptureStepIndex(stepIndex);
      setCaptureInstruction(AUTO_CAPTURE_STEPS[stepIndex]);

      for (let remaining = AUTO_CAPTURE_COUNTDOWN_SECONDS; remaining > 0; remaining -= 1) {
        setCaptureCountdown(remaining);
        await new Promise((resolve) => {
          countdownTimerRef.current = setTimeout(resolve, 1000);
        });

        if (autoCaptureAbortRef.current) {
          break;
        }
      }

      if (autoCaptureAbortRef.current) {
        break;
      }

      setCaptureCountdown(0);
      triggerCaptureFlash();

      const captureResult = await captureBestFaceBurst();
      if (!captureResult.ok) {
        setError(captureResult.reason || "Face not detected clearly - please try again");
        continue;
      }

      const nextStepCount = stepIndex + 1;
      appendCapturedPhoto(
        captureResult.dataUrl,
        captureResult.descriptor,
        nextStepCount,
        captureResult.quality || null
      );
      setAutoCapturedCount(nextStepCount);
      setError("");
      stepIndex += 1;
    }

    stopCountdown();
    setAutoCaptureRunning(false);
    setBusy(false);

    if (!autoCaptureAbortRef.current && stepIndex >= AUTO_CAPTURE_STEPS.length) {
      setAutoCaptureCompleted(true);
      setSuccess(
        "Capture complete. Review details and register identity."
      );
    }
  }, [
    appendCapturedPhoto,
    autoCaptureRunning,
    busy,
    captureBestFaceBurst,
    stopCountdown,
    triggerCaptureFlash,
    validateCapturePrerequisites,
    waitForVideoReady,
    bindCaptureStreamToVideo,
  ]);

  const saveRegistration = useCallback(async () => {
    const fullName = String(form.fullName || "").trim();
    const studentId = String(form.studentId || "").trim();
    const program = String(form.program || "");
    const year = String(form.year || "");
    const phone = String(form.phone || "").trim();

    if (!fullName) {
      setError("Full Name is required.");
      return;
    }

    if (!studentId) {
      setError("Student ID is required.");
      return;
    }

    if (!PROGRAM_OPTIONS.includes(program)) {
      setError("Please select a valid program.");
      return;
    }

    if (!YEAR_OPTIONS.includes(year)) {
      setError("Please select a valid year.");
      return;
    }

    const existingByStudentId = registry.find(
      (entry) => entry.studentId === studentId && entry.studentId !== editingStudentId
    );
    if (existingByStudentId) {
      const confirmedUpdate = window.confirm(
        `Update existing registration for ${existingByStudentId.fullName}?`
      );

      if (!confirmedUpdate) {
        setError("Registration cancelled.");
        return;
      }
    }

    if (liveCaptureStarted && !autoCaptureCompleted) {
      setError("Complete all 5 live-capture steps before saving.");
      return;
    }

    const baseRecord =
      existingByStudentId || registry.find((entry) => entry.studentId === editingStudentId) || null;
    const mergedDescriptors = mergeDescriptors(baseRecord?.descriptors || [], draftDescriptors);
    const mergedPhotos = mergePhotos(baseRecord?.photos || [], draftPhotos);

    if (mergedPhotos.length < MAX_FACE_PHOTOS) {
      setError(`Capture all ${MAX_FACE_PHOTOS} guided photos before registration.`);
      return;
    }

    if (mergedDescriptors.length < MIN_SUCCESSFUL_DETECTIONS) {
      setError(
        `At least ${MIN_SUCCESSFUL_DETECTIONS} successful face detections are required before saving.`
      );
      return;
    }

    setBusy(true);
    setError("");

    try {
      const faceEngine = await ensureFaceEngine();
      const targetStudentId = existingByStudentId?.studentId || studentId;
      const targetName = fullName || existingByStudentId?.fullName || "Unknown";

      const nextRecord = normalizeRecord({
        id: existingByStudentId?.id || editingStudentId || targetStudentId,
        fullName: targetName,
        studentId: targetStudentId,
        program,
        year,
        phone,
        photos: mergedPhotos,
        descriptors: mergedDescriptors,
        createdAt:
          baseRecord?.createdAt ||
          new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      if (!nextRecord) {
        setError("Unable to save registration.");
        return;
      }

      if (editingStudentId && editingStudentId !== targetStudentId) {
        faceEngine.clearPerson(editingStudentId);
        try {
          await axios.delete(`${API_BASE}/api/students/${encodeURIComponent(editingStudentId)}`, {
            headers: getAuthHeaders(),
          });
        } catch (deleteError) {
          if (deleteError?.response?.status !== 404) {
            throw deleteError;
          }
        }
      }

      const descriptorsToEnroll = Array.isArray(nextRecord.descriptors)
        ? nextRecord.descriptors.slice(-MAX_FACE_PHOTOS)
        : [];
      const averagedDescriptor = averageDescriptorVectors(descriptorsToEnroll);
      const seedDescriptor =
        averagedDescriptor.length > 0
          ? averagedDescriptor
          : descriptorsToEnroll[descriptorsToEnroll.length - 1]
        || mergedDescriptors[mergedDescriptors.length - 1]
        || [];

      await axios.post(`${API_BASE}/api/students`, {
        studentId: nextRecord.studentId,
        name: nextRecord.fullName,
        program: nextRecord.program,
        year: Number(nextRecord.year),
        phone: nextRecord.phone,
        faceDescriptor: seedDescriptor,
      }, {
        headers: getAuthHeaders(),
      });

      const latestQuality = draftDescriptorQuality[draftDescriptorQuality.length - 1] || null;
      let enrollSuccessCount = 0;
      let enrollFailureMessage = "";

      for (let index = 0; index < descriptorsToEnroll.length; index += 1) {
        const descriptor = descriptorsToEnroll[index];
        const quality =
          draftDescriptorQuality[draftDescriptorQuality.length - descriptorsToEnroll.length + index]
          || latestQuality;

        try {
          await axios.post(`${API_BASE}/api/recognition/enroll`, {
            studentId: nextRecord.studentId,
            name: nextRecord.fullName,
            program: nextRecord.program,
            year: Number(nextRecord.year),
            phone: nextRecord.phone,
            faceDescriptor: descriptor,
            quality,
          }, {
            headers: getAuthHeaders(),
          });
          enrollSuccessCount += 1;
        } catch (enrollError) {
          enrollFailureMessage = String(enrollError?.response?.data?.message || enrollError?.message || "").trim();
        }
      }

      if (enrollSuccessCount === 0 && (!Array.isArray(seedDescriptor) || seedDescriptor.length === 0)) {
        throw new Error(enrollFailureMessage || "Failed to save face descriptors.");
      }

      faceEngine.setPersonDescriptors(
        nextRecord.studentId,
        nextRecord.fullName,
        nextRecord.descriptors
      );

      setRegistry((prev) => {
        const targetId = existingByStudentId?.studentId || editingStudentId || "";
        const mergedSourceId =
          editingStudentId && existingByStudentId && editingStudentId !== existingByStudentId.studentId
            ? editingStudentId
            : "";
        const baseList = mergedSourceId
          ? prev.filter((entry) => entry.studentId !== mergedSourceId)
          : prev;
        const exists = prev.some(
          (entry) => entry.studentId === targetId || entry.studentId === nextRecord.studentId
        );

        if (!exists) {
          return [
            nextRecord,
            ...baseList.filter((entry) => entry.studentId !== nextRecord.studentId),
          ];
        }

        return baseList.map((entry) =>
          entry.studentId === targetId || entry.studentId === nextRecord.studentId
            ? nextRecord
            : entry
        );
      });

      const report = buildConsistencyReport(nextRecord.descriptors);

      setConsistencyReport(report);
      setRegistrationCompleted(true);
      setCurrentStep(3);
      setError("");
      setSuccess(
        enrollSuccessCount === 0
          ? "Identity saved in student data. Re-capture later for stronger face accuracy."
          : "Identity Registered Successfully"
      );

      if (typeof onRegistrationSaved === "function") {
        await Promise.resolve(onRegistrationSaved());
      }
    } catch (saveError) {
      const backendMessage = String(saveError?.response?.data?.message || "").trim();
      setError(backendMessage || "Failed to save registration.");
    } finally {
      setBusy(false);
    }
  }, [
    draftDescriptors,
    draftDescriptorQuality,
    draftPhotos,
    ensureFaceEngine,
    editingStudentId,
    form.fullName,
    form.phone,
    form.program,
    form.studentId,
    form.year,
    autoCaptureCompleted,
    liveCaptureStarted,
    onRegistrationSaved,
    registry,
  ]);

  const clearAllData = useCallback(async () => {
    const confirmation = window.prompt(
      "Type CLEAR to delete all students and face data."
    );

    if (confirmation !== "CLEAR") {
      setError("Clear all cancelled.");
      return;
    }

    setBusy(true);
    setError("");
    setSuccess("");

    try {
      const faceEngine = await ensureFaceEngine();
      await axios.delete(`${API_BASE}/api/students`, {
        headers: getAuthHeaders(),
      });
      faceEngine.clearAllPeople();
      clearAllLocalRegistries();
      setRegistry([]);
      window.location.reload();
    } catch (clearError) {
      setError("Failed to clear all student data.");
      setBusy(false);
    }
  }, [ensureFaceEngine]);

  const removeRecord = useCallback(
    async (record) => {
      const confirmed = window.confirm(
        `Remove ${record.fullName} from system? This will delete all their tracking data.`
      );
      if (!confirmed) {
        return;
      }

      setBusy(true);
      setError("");

      try {
        const faceEngine = await ensureFaceEngine();
        try {
          await axios.delete(`${API_BASE}/api/students/${encodeURIComponent(record.studentId)}`, {
            headers: getAuthHeaders(),
          });
        } catch (deleteError) {
          if (deleteError?.response?.status !== 404) {
            setError("Failed to remove student from backend.");
            return;
          }
        }

        setRegistry((prev) => prev.filter((entry) => entry.studentId !== record.studentId));
        faceEngine.clearPerson(record.studentId);
        removeFromLocalRegistry(record.studentId);

        if (editingStudentId === record.studentId) {
          resetEditor();
        }

        setSuccess(`${record.fullName} removed from system.`);
        setError("");
      } finally {
        setBusy(false);
      }
    },
    [editingStudentId, ensureFaceEngine, resetEditor]
  );

  const exportRegistry = useCallback(() => {
    const payload = registry.map((entry) => ({
      fullName: entry.fullName,
      studentId: entry.studentId,
      program: entry.program,
      year: Number(entry.year),
      phone: entry.phone || "",
    }));

    const file = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = `omni-registry-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [registry]);

  const importRegistry = useCallback(
    async (event) => {
      const file = event.target.files?.[0];
      event.target.value = "";

      if (!file) {
        return;
      }

      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) {
          setError("Import file must contain an array of student records.");
          return;
        }

        const normalized = parsed
          .map((entry) =>
            normalizeRecord({
              fullName: entry?.fullName || entry?.name,
              studentId: entry?.studentId,
              program: entry?.program,
              year: String(entry?.year || "1"),
              phone: entry?.phone || "",
              photos: [],
              descriptors: [],
            })
          )
          .filter(Boolean);

        const confirmed = window.confirm(
          "Import will replace current local registry. Continue?"
        );
        if (!confirmed) {
          return;
        }

        setRegistry(normalized);
        await syncingEngineFromRegistry(normalized);
        resetEditor();
        setSuccess(
          `Imported ${normalized.length} students. Please re-capture faces for recognition.`
        );
        setError("");
      } catch (importError) {
        setError("Failed to import registry file.");
      }
    },
    [resetEditor, syncingEngineFromRegistry]
  );

  const steps = useMemo(
    () => [
      { id: 1, label: "Basic Info" },
      { id: 2, label: "Face Capture" },
      { id: 3, label: "Review & Save" },
    ],
    []
  );

  const isStepOneValid = useMemo(() => {
    const fullName = String(form.fullName || "").trim();
    const studentId = String(form.studentId || "").trim();
    return (
      Boolean(fullName)
      && Boolean(studentId)
      && PROGRAM_OPTIONS.includes(String(form.program || ""))
      && YEAR_OPTIONS.includes(String(form.year || ""))
    );
  }, [form.fullName, form.program, form.studentId, form.year]);

  const stepOneInvalid = useMemo(
    () => ({
      fullName: !String(form.fullName || "").trim(),
      studentId: !String(form.studentId || "").trim(),
      program: !PROGRAM_OPTIONS.includes(String(form.program || "")),
      year: !YEAR_OPTIONS.includes(String(form.year || "")),
    }),
    [form.fullName, form.program, form.studentId, form.year]
  );

  const showStepOneValidation = stepOneValidationTick > 0;

  const captureProgressCount = Math.min(MAX_FACE_PHOTOS, draftPhotos.length);

  const canProceedToReview = useMemo(() => {
    return (
      captureProgressCount >= MAX_FACE_PHOTOS
      && draftDescriptors.length >= MIN_SUCCESSFUL_DETECTIONS
    );
  }, [captureProgressCount, draftDescriptors.length]);

  const activeCaptureHint = useMemo(() => {
    if (!showWebcamPreview) {
      return "Align your face inside the frame";
    }

    if (autoCaptureRunning && captureCountdown > 0) {
      return "Hold still...";
    }

    if (autoCaptureRunning) {
      return captureInstruction || "Detecting face...";
    }

    if (showWebcamPreview && captureProgressCount < 2) {
      return "Move closer";
    }

    if (captureProgressCount >= MAX_FACE_PHOTOS) {
      return "Capture complete";
    }

    if (captureProgressCount > 0) {
      return "Face detected";
    }

    return "Good lighting detected";
  }, [autoCaptureRunning, captureCountdown, captureInstruction, captureProgressCount, showWebcamPreview]);

  const captureVisualState = useMemo(() => {
    if (captureProgressCount >= MAX_FACE_PHOTOS || autoCaptureCompleted) {
      return "success";
    }

    if (autoCaptureRunning && captureCountdown > 0) {
      return "capturing";
    }

    if (showWebcamPreview && captureProgressCount > 0) {
      return "locked";
    }

    if (showWebcamPreview || autoCaptureRunning) {
      return "detecting";
    }

    return "idle";
  }, [autoCaptureCompleted, autoCaptureRunning, captureCountdown, captureProgressCount, showWebcamPreview]);

  const stepDescription = useMemo(() => {
    if (currentStep === 1) {
      return "Start with identity details before secure biometric capture.";
    }

    if (currentStep === 2) {
      return "We will capture 5 guided angles for reliable recognition.";
    }

    return "Review details and captured photos, then finalize registration.";
  }, [currentStep]);

  const moveToCaptureStep = useCallback(() => {
    if (!isStepOneValid) {
      setStepOneValidationTick((prev) => prev + 1);
      setError("Fill Full Name, Student ID, Program, and Year to continue.");
      return;
    }

    setError("");
    setStepOneValidationTick(0);
    setCurrentStep(2);
  }, [isStepOneValid]);

  const moveToReviewStep = useCallback(() => {
    if (!canProceedToReview) {
      setError(`Capture all ${MAX_FACE_PHOTOS} guided photos before reviewing.`);
      return;
    }

    setError("");
    setCurrentStep(3);
  }, [canProceedToReview]);

  const retakePhotos = useCallback(() => {
    autoCaptureAbortRef.current = true;
    setDraftPhotos([]);
    setDraftDescriptors([]);
    setAutoCapturedCount(0);
    setAutoCaptureCompleted(false);
    setAutoCaptureStepIndex(0);
    setCaptureInstruction(AUTO_CAPTURE_STEPS[0]);
    setCaptureCountdown(0);
    setCaptureFlash(false);
    setShowWebcamPreview(true);
    setLiveCaptureStarted(false);
    setRegistrationCompleted(false);
    setError("");
    setSuccess("");
    setCurrentStep(2);
  }, []);

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-[1450] overflow-y-auto bg-[#070b12]/85 px-4 py-6 backdrop-blur-sm"
      onClick={closeModal}
    >
      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 20, scale: 0.98 }}
        transition={{ duration: 0.22, ease: "easeOut" }}
        className="relative mx-auto my-auto flex max-h-[92vh] w-full max-w-[900px] flex-col overflow-hidden rounded-[20px] border border-white/10 bg-[#0b0f14]/95 p-6 shadow-[0_18px_70px_rgba(0,0,0,0.55)]"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={closeModal}
          className="absolute right-4 top-4 rounded-xl border border-white/15 px-2.5 py-1 text-xs text-slate-300 transition hover:border-cyan-300/45 hover:text-cyan-100"
        >
          X
        </button>

        <div className="flex min-h-0 flex-1 flex-col gap-6">
          <div className="flex flex-wrap items-start justify-between gap-4 pr-11 sm:pr-10">
            <div className="min-w-0 flex-1 space-y-2">
              <p className="text-[11px] uppercase tracking-[0.22em] text-cyan-200/75">
                Secure Identity Onboarding
              </p>
              <h3 className="text-2xl font-semibold text-slate-100">Register New Identity</h3>
              <p className="max-w-[56ch] text-sm text-slate-400">{stepDescription}</p>
            </div>

            <div className="relative">
              <button
                type="button"
                className="rounded-xl border border-white/15 bg-white/[0.04] px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-200 transition hover:border-cyan-300/40 hover:text-cyan-100"
                onClick={() => setShowAdvancedMenu((prev) => !prev)}
              >
                Advanced
              </button>

              <AnimatePresence>
                {showAdvancedMenu ? (
                  <motion.div
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    className="absolute right-0 top-12 z-20 w-56 rounded-2xl border border-white/10 bg-[#0e1420]/95 p-2 shadow-[0_14px_36px_rgba(0,0,0,0.4)]"
                  >
                    <button
                      type="button"
                      className="w-full rounded-xl px-3 py-2 text-left text-sm text-slate-200 transition hover:bg-white/[0.05] hover:text-cyan-100"
                      onClick={() => {
                        exportRegistry();
                        setShowAdvancedMenu(false);
                      }}
                    >
                      Export Registry
                    </button>
                    <button
                      type="button"
                      className="w-full rounded-xl px-3 py-2 text-left text-sm text-slate-200 transition hover:bg-white/[0.05] hover:text-cyan-100"
                      onClick={() => {
                        importInputRef.current?.click();
                        setShowAdvancedMenu(false);
                      }}
                    >
                      Import Registry
                    </button>
                    <input
                      ref={importInputRef}
                      type="file"
                      accept="application/json"
                      onChange={importRegistry}
                      hidden
                    />
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>
          </div>

          <div className="custom-scrollbar min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
            <div className="space-y-3">
            <div className="h-1.5 rounded-full bg-white/[0.06]">
              <motion.div
                initial={false}
                animate={{ width: `${(currentStep / steps.length) * 100}%` }}
                className="h-full rounded-full bg-gradient-to-r from-cyan-300 to-cyan-500"
              />
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {steps.map((step) => {
                const active = currentStep === step.id;
                const done = currentStep > step.id;
                return (
                  <motion.div
                    layout
                    key={step.id}
                    animate={{
                      scale: active ? 1.02 : 1,
                      y: active ? -1 : 0,
                    }}
                    transition={{ type: "spring", stiffness: 280, damping: 24 }}
                    className={`rounded-2xl border px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-[0.12em] transition sm:text-xs sm:tracking-[0.14em] ${
                      active
                        ? "border-cyan-300/60 bg-cyan-500/15 text-cyan-100"
                        : done
                          ? "border-cyan-300/30 bg-cyan-500/10 text-cyan-200"
                          : "border-white/10 bg-white/[0.03] text-slate-400"
                    }`}
                  >
                    <motion.span
                      className="inline-flex items-center gap-1.5"
                      animate={{ opacity: active || done ? 1 : 0.85 }}
                      transition={{ duration: 0.2 }}
                    >
                      <motion.i
                        className="inline-block rounded-full bg-current"
                        animate={{
                          width: active ? 10 : 6,
                          height: active ? 10 : 6,
                          opacity: done ? 0.95 : 0.8,
                        }}
                        transition={{ duration: 0.18 }}
                      />
                      {step.label}
                    </motion.span>
                  </motion.div>
                );
              })}
            </div>
            </div>

          {error ? (
            <div className="rounded-2xl border border-red-300/35 bg-red-500/10 px-4 py-2.5 text-sm text-red-200">
              {error}
            </div>
          ) : null}

          {success && !registrationCompleted ? (
            <div className="rounded-2xl border border-cyan-300/35 bg-cyan-500/10 px-4 py-2.5 text-sm text-cyan-100">
              {success}
            </div>
          ) : null}

          <AnimatePresence mode="wait">
            <motion.section
              key={`wizard-step-${currentStep}`}
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -18 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="space-y-5"
            >
              {currentStep === 1 ? (
                <>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <motion.label
                      className="space-y-1"
                      animate={showStepOneValidation && stepOneInvalid.fullName ? { x: [0, -4, 4, 0] } : { x: 0 }}
                      transition={{ duration: 0.24 }}
                    >
                      <span className="text-xs uppercase tracking-[0.14em] text-slate-400">Full Name</span>
                      <input
                        value={form.fullName}
                        onChange={(event) => {
                          setForm((prev) => ({ ...prev, fullName: event.target.value }));
                          setError("");
                        }}
                        placeholder="Student full name"
                        className={`w-full rounded-2xl border bg-white/[0.04] px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-cyan-300/50 ${
                          showStepOneValidation && stepOneInvalid.fullName
                            ? "border-amber-300/50"
                            : "border-white/15"
                        }`}
                      />
                    </motion.label>

                    <motion.label
                      className="space-y-1"
                      animate={showStepOneValidation && stepOneInvalid.studentId ? { x: [0, -4, 4, 0] } : { x: 0 }}
                      transition={{ duration: 0.24 }}
                    >
                      <span className="text-xs uppercase tracking-[0.14em] text-slate-400">Student ID</span>
                      <input
                        value={form.studentId}
                        onChange={(event) => {
                          setForm((prev) => ({ ...prev, studentId: event.target.value }));
                          setError("");
                        }}
                        placeholder="CSE2024001"
                        className={`w-full rounded-2xl border bg-white/[0.04] px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-cyan-300/50 ${
                          showStepOneValidation && stepOneInvalid.studentId
                            ? "border-amber-300/50"
                            : "border-white/15"
                        }`}
                      />
                    </motion.label>

                    <motion.label
                      className="space-y-1"
                      animate={showStepOneValidation && stepOneInvalid.program ? { x: [0, -4, 4, 0] } : { x: 0 }}
                      transition={{ duration: 0.24 }}
                    >
                      <span className="text-xs uppercase tracking-[0.14em] text-slate-400">Program</span>
                      <select
                        value={form.program}
                        onChange={(event) => setForm((prev) => ({ ...prev, program: event.target.value }))}
                        className={`w-full rounded-2xl border bg-white/[0.04] px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-cyan-300/50 ${
                          showStepOneValidation && stepOneInvalid.program
                            ? "border-amber-300/50"
                            : "border-white/15"
                        }`}
                      >
                        {PROGRAM_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </motion.label>

                    <motion.label
                      className="space-y-1"
                      animate={showStepOneValidation && stepOneInvalid.year ? { x: [0, -4, 4, 0] } : { x: 0 }}
                      transition={{ duration: 0.24 }}
                    >
                      <span className="text-xs uppercase tracking-[0.14em] text-slate-400">Year</span>
                      <select
                        value={form.year}
                        onChange={(event) => setForm((prev) => ({ ...prev, year: event.target.value }))}
                        className={`w-full rounded-2xl border bg-white/[0.04] px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-cyan-300/50 ${
                          showStepOneValidation && stepOneInvalid.year
                            ? "border-amber-300/50"
                            : "border-white/15"
                        }`}
                      >
                        {YEAR_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </motion.label>
                  </div>

                  <div className="flex items-center justify-between gap-3 pt-2">
                    <button
                      type="button"
                      className="rounded-xl border border-white/15 px-4 py-2.5 text-sm text-slate-300 transition hover:border-cyan-300/35 hover:text-cyan-100"
                      onClick={closeModal}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="neon-btn"
                      onClick={moveToCaptureStep}
                    >
                      Continue →
                    </button>
                  </div>
                </>
              ) : null}

              {currentStep === 2 ? (
                <>
                  <div className="rounded-[20px] border border-white/10 bg-white/[0.03] p-4 md:p-5">
                    <FaceCaptureOverlay
                      videoRef={captureVideoRef}
                      showPreview={showWebcamPreview}
                      detectionState={captureVisualState}
                      instruction={activeCaptureHint}
                      captureCountdown={captureCountdown}
                      captureFlash={captureFlash}
                      progressCount={captureProgressCount}
                      totalCount={MAX_FACE_PHOTOS}
                    />

                    <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-xs uppercase tracking-[0.14em] text-slate-400">Camera Source</p>
                        <button
                          type="button"
                          className="rounded-lg border border-white/15 bg-white/[0.04] px-3 py-1.5 text-[11px] font-semibold text-slate-200 transition hover:border-cyan-300/35 hover:text-cyan-100"
                          onClick={() => {
                            void refreshCaptureDevices();
                          }}
                        >
                          Refresh Cameras
                        </button>
                      </div>

                      <select
                        value={captureDeviceId}
                        onChange={(event) => {
                          setCaptureDeviceId(event.target.value);
                          setError("");
                        }}
                        className="mt-2 w-full rounded-xl border border-white/15 bg-white/[0.04] px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-cyan-300/50"
                      >
                        {captureDevices.length === 0 ? (
                          <option value="">Default webcam</option>
                        ) : (
                          captureDevices.map((device, index) => (
                            <option key={device.deviceId || `capture-device-${index}`} value={device.deviceId}>
                              {device.label || `Webcam ${index + 1}`}
                            </option>
                          ))
                        )}
                      </select>

                      <p className="mt-2 text-xs text-slate-400">
                        Iriun webcam is auto-preferred when available.
                      </p>
                    </div>

                    <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          className="rounded-xl border border-white/15 px-3 py-2 text-sm text-slate-300 transition hover:border-cyan-300/35 hover:text-cyan-100"
                          onClick={() => setCurrentStep(1)}
                        >
                          Back
                        </button>
                        <button
                          type="button"
                          className="rounded-xl border border-white/15 px-3 py-2 text-sm text-slate-300 transition hover:border-cyan-300/35 hover:text-cyan-100"
                          onClick={() => uploadInputRef.current?.click()}
                        >
                          Upload Instead
                        </button>
                        <input
                          ref={uploadInputRef}
                          type="file"
                          accept="image/jpeg,image/png"
                          multiple
                          onChange={handleUploadInput}
                          hidden
                        />
                      </div>

                      <div className="flex items-center gap-2">
                        {autoCaptureRunning ? (
                          <button
                            type="button"
                            className="rounded-xl border border-red-300/35 bg-red-500/10 px-3 py-2 text-sm font-semibold text-red-100 transition hover:bg-red-500/20"
                            onClick={stopAutoCapture}
                          >
                            Stop
                          </button>
                        ) : null}

                        {canProceedToReview ? (
                          <button type="button" className="neon-btn" onClick={moveToReviewStep}>
                            Continue →
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="neon-btn"
                            onClick={() => {
                              setShowWebcamPreview(true);
                              void startAutoFaceCapture();
                            }}
                            disabled={busy || autoCaptureRunning || hydrating}
                          >
                            {autoCaptureRunning ? "Capturing..." : "Start Capture"}
                          </button>
                        )}
                      </div>
                    </div>

                    {hydrating ? (
                      <p className="mt-3 text-xs text-slate-400">Preparing secure biometric engine...</p>
                    ) : null}
                  </div>
                </>
              ) : null}

              {currentStep === 3 ? (
                <>
                  {registrationCompleted ? (
                    <div className="rounded-2xl border border-emerald-300/35 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
                      ✅ Identity Registered Successfully
                    </div>
                  ) : null}

                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                      <p className="text-xs uppercase tracking-[0.14em] text-slate-400">Identity Summary</p>
                      <dl className="mt-3 space-y-2 text-sm text-slate-200">
                        <div className="flex items-center justify-between gap-3">
                          <dt className="text-slate-400">Full Name</dt>
                          <dd className="font-medium">{form.fullName || "-"}</dd>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <dt className="text-slate-400">Student ID</dt>
                          <dd className="font-medium">{form.studentId || "-"}</dd>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <dt className="text-slate-400">Program</dt>
                          <dd className="font-medium">{form.program || "-"}</dd>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <dt className="text-slate-400">Year</dt>
                          <dd className="font-medium">{form.year || "-"}</dd>
                        </div>
                      </dl>

                      {consistencyReport ? (
                        <div className="mt-4 rounded-xl border border-white/10 bg-black/20 p-3">
                          <p className="text-xs uppercase tracking-[0.14em] text-slate-400">Recognition Confidence</p>
                          <div className="mt-2 h-2 rounded-full bg-white/10">
                            <div
                              className={`h-full rounded-full ${
                                consistencyReport.tone === "green"
                                  ? "bg-emerald-300"
                                  : consistencyReport.tone === "yellow"
                                    ? "bg-amber-300"
                                    : "bg-red-300"
                              }`}
                              style={{ width: `${consistencyReport.confidencePct}%` }}
                            />
                          </div>
                          <p className="mt-2 text-xs text-slate-300">
                            Consistency score: {consistencyReport.label}
                          </p>
                        </div>
                      ) : null}
                    </div>

                    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                      <p className="text-xs uppercase tracking-[0.14em] text-slate-400">Captured Photos</p>
                      <div className="mt-3 grid grid-cols-3 gap-2">
                        {draftPhotos.map((photo) => (
                          <figure
                            key={photo.id}
                            className="overflow-hidden rounded-xl border border-white/10 bg-black/20"
                          >
                            <img src={photo.dataUrl} alt="Captured face" className="h-20 w-full object-cover" />
                          </figure>
                        ))}
                      </div>
                      {draftPhotos.length === 0 ? (
                        <p className="mt-3 text-sm text-slate-400">No captures available yet.</p>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="rounded-xl border border-white/15 px-3 py-2 text-sm text-slate-300 transition hover:border-cyan-300/35 hover:text-cyan-100"
                        onClick={retakePhotos}
                      >
                        Retake Photos
                      </button>
                      {!registrationCompleted ? (
                        <button
                          type="button"
                          className="rounded-xl border border-white/15 px-3 py-2 text-sm text-slate-300 transition hover:border-cyan-300/35 hover:text-cyan-100"
                          onClick={() => setCurrentStep(2)}
                        >
                          Back
                        </button>
                      ) : null}
                    </div>

                    {registrationCompleted ? (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          className="rounded-xl border border-white/15 px-3 py-2 text-sm text-slate-300 transition hover:border-cyan-300/35 hover:text-cyan-100"
                          onClick={() => {
                            resetEditor();
                            setSuccess("");
                          }}
                        >
                          Register Another
                        </button>
                        <button type="button" className="neon-btn" onClick={closeModal}>
                          Done
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="neon-btn"
                        onClick={() => {
                          setRegistrationCompleted(false);
                          void saveRegistration();
                        }}
                        disabled={busy}
                      >
                        Register Identity
                      </button>
                    )}
                  </div>
                </>
              ) : null}
            </motion.section>
          </AnimatePresence>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
