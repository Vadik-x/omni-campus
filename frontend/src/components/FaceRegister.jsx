import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { faceEngine } from "../lib/faceEngine";

const STORAGE_KEY = "omni:registry:v2";
const LEGACY_STORAGE_KEY = "omni:faces:v1";
const ENGINE_STORAGE_KEY = "omni_face_registry";
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

const MIN_SUCCESSFUL_DETECTIONS = 2;
const AUTO_CAPTURE_COUNTDOWN_SECONDS = 3;
const AUTO_CAPTURE_STEPS = [
  "Look straight ahead",
  "Turn slightly left",
  "Turn slightly right",
  "Tilt head slightly up",
  "Look straight again",
];

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
    ? entry.photos.map(normalizePhoto).filter(Boolean).slice(0, MAX_FACE_PHOTOS)
    : [];

  const descriptors = Array.isArray(entry?.descriptors)
    ? entry.descriptors
        .map((item) => normalizeDescriptorArray(item))
        .filter(Boolean)
        .slice(0, MAX_FACE_PHOTOS)
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
  emitEvent,
  students = [],
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
  const [uploadResults, setUploadResults] = useState([]);
  const [consistencyReport, setConsistencyReport] = useState(null);
  const [liveCaptureStarted, setLiveCaptureStarted] = useState(false);

  const captureVideoRef = useRef(null);
  const captureStreamRef = useRef(null);
  const uploadInputRef = useRef(null);
  const importInputRef = useRef(null);
  const countdownTimerRef = useRef(null);
  const flashTimerRef = useRef(null);
  const autoCaptureAbortRef = useRef(false);

  const statusMap = useMemo(() => {
    const map = new Map();
    (students || []).forEach((student) => {
      map.set(student.studentId, student.status || "offline");
    });
    return map;
  }, [students]);

  const syncingEngineFromRegistry = useCallback(async (entries) => {
    await faceEngine.loadModels();
    faceEngine.clearAllPeople();

    entries.forEach((entry) => {
      if (Array.isArray(entry.descriptors) && entry.descriptors.length > 0) {
        faceEngine.setPersonDescriptors(entry.studentId, entry.fullName, entry.descriptors);
      }
    });
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(registry));
  }, [registry]);

  useEffect(() => {
    let cancelled = false;

    const hydrate = async () => {
      try {
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
  }, [syncingEngineFromRegistry]);

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

  useEffect(() => {
    return () => {
      if (flashTimerRef.current) {
        clearTimeout(flashTimerRef.current);
        flashTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!open || !showWebcamPreview) {
      stopAutoCapture();
      stopCountdown();
      stopCamera();
      return undefined;
    }

    navigator.mediaDevices
      .getUserMedia({ video: true, audio: false })
      .then((stream) => {
        captureStreamRef.current = stream;
        if (captureVideoRef.current) {
          captureVideoRef.current.srcObject = stream;
          captureVideoRef.current.play().catch(() => undefined);
        }
      })
      .catch(() => {
        setError("Unable to access webcam for live capture.");
      });

    return () => {
      stopAutoCapture();
      stopCountdown();
      stopCamera();
    };
  }, [open, showWebcamPreview, stopAutoCapture, stopCamera, stopCountdown]);

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
    (dataUrl, descriptor, explicitCount = null) => {
      const studentId = String(form.studentId || "").trim() || "student";
      const photoId = `${studentId}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
      const nextPhoto = { id: photoId, dataUrl };

      setDraftPhotos((prev) => [...prev, nextPhoto].slice(0, MAX_FACE_PHOTOS));
      setDraftDescriptors((prev) => [...prev, descriptor].slice(0, MAX_FACE_PHOTOS));
      setPreviewUrl(dataUrl);

      const nextCount = Number.isFinite(Number(explicitCount))
        ? Number(explicitCount)
        : Math.min(draftPhotos.length + 1, MAX_FACE_PHOTOS);
      setSuccess(`Face photo added (${nextCount}/${MAX_FACE_PHOTOS}).`);
    },
    [draftPhotos.length, form.studentId]
  );

  const extractDescriptorFromDataUrl = useCallback(async (dataUrl) => {
    try {
      const image = await loadImage(dataUrl);
      const result = await faceEngine.extractFaceDescriptor(image, {
        inputSize: 320,
        scoreThreshold: 0.25,
      });

      const descriptor = normalizeDescriptorArray(result?.descriptor);
      if (!descriptor) {
        return {
          ok: false,
          reason: "Face not detected clearly - please try again",
        };
      }

      return { ok: true, descriptor };
    } catch (captureError) {
      return {
        ok: false,
        reason: "Failed to process face photo.",
      };
    }
  }, []);

  const waitForVideoReady = useCallback(async (timeoutMs = 5000) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const video = captureVideoRef.current;
      if (video && video.readyState >= 2 && Number(video.videoWidth) > 0) {
        return true;
      }

      await new Promise((resolve) => {
        countdownTimerRef.current = setTimeout(resolve, 120);
      });
    }

    return false;
  }, []);

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
          appendCapturedPhoto(dataUrl, extraction.descriptor, draftPhotos.length + successCount);
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

    const ready = await waitForVideoReady(7000);
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

      const dataUrl = captureFrameDataUrl();
      if (!dataUrl) {
        setError("Webcam is not ready yet.");
        continue;
      }

      const extraction = await extractDescriptorFromDataUrl(dataUrl);
      if (!extraction.ok) {
        setError("Face not detected clearly - please try again");
        continue;
      }

      const nextStepCount = stepIndex + 1;
      appendCapturedPhoto(dataUrl, extraction.descriptor, nextStepCount);
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
        "5 photos captured! Registration complete.\nThis person will now be recognized from multiple angles and distances."
      );
    }
  }, [
    appendCapturedPhoto,
    autoCaptureRunning,
    busy,
    captureFrameDataUrl,
    extractDescriptorFromDataUrl,
    stopCountdown,
    triggerCaptureFlash,
    validateCapturePrerequisites,
    waitForVideoReady,
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

    if (mergedDescriptors.length < MIN_SUCCESSFUL_DETECTIONS) {
      setError("At least 2 successful face detections are required before saving.");
      return;
    }

    setBusy(true);
    setError("");

    try {
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
          await axios.delete(`${API_BASE}/api/students/${encodeURIComponent(editingStudentId)}`);
        } catch (deleteError) {
          if (deleteError?.response?.status !== 404) {
            throw deleteError;
          }
        }
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

      if (typeof emitEvent === "function") {
        emitEvent("student:register", {
          studentId: nextRecord.studentId,
          name: nextRecord.fullName,
          program: nextRecord.program,
          year: Number(nextRecord.year),
          phone: nextRecord.phone,
          faceDescriptor:
            nextRecord.descriptors[nextRecord.descriptors.length - 1] ||
            nextRecord.descriptors[0] ||
            [],
        });
      }

      const report = buildConsistencyReport(nextRecord.descriptors);

      resetEditor();
      setConsistencyReport(report);
      setSuccess(
        `${nextRecord.fullName} registered! System will now recognize him on all cameras.`
      );
    } catch (saveError) {
      setError("Failed to save registration.");
    } finally {
      setBusy(false);
    }
  }, [
    draftDescriptors,
    draftPhotos,
    editingStudentId,
    emitEvent,
    form.fullName,
    form.phone,
    form.program,
    form.studentId,
    form.year,
    autoCaptureCompleted,
    liveCaptureStarted,
    registry,
    resetEditor,
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
      await axios.delete(`${API_BASE}/api/students`);
      faceEngine.clearAllPeople();
      clearAllLocalRegistries();
      setRegistry([]);
      window.location.reload();
    } catch (clearError) {
      setError("Failed to clear all student data.");
      setBusy(false);
    }
  }, []);

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
        try {
          await axios.delete(`${API_BASE}/api/students/${encodeURIComponent(record.studentId)}`);
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
    [editingStudentId, resetEditor]
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

  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop register-backdrop" onClick={closeModal}>
      <div className="modal-card register-modal-shell" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="close-btn register-close-btn" onClick={closeModal}>
          X
        </button>

        <div className="register-topbar">
          <div>
            <h3>Face Registry</h3>
            <p className="register-count">{registry.length} people registered</p>
          </div>

          <div className="register-toolbar">
            <button type="button" className="camera-remove-btn" onClick={exportRegistry}>
              Export Registry
            </button>
            <button
              type="button"
              className="camera-remove-btn"
              onClick={() => importInputRef.current?.click()}
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
          </div>
        </div>

        <div className="registry-layout">
          <section className="registry-editor">
            <p className="editor-mode">
              {mode === "create" ? "New Registration" : mode === "edit" ? "Edit Info" : "Add More Photos"}
            </p>

            <div className="editor-grid">
              <label>
                Full Name
                <input
                  value={form.fullName}
                  onChange={(event) => {
                    setForm((prev) => ({ ...prev, fullName: event.target.value }));
                    setError("");
                  }}
                  placeholder="Student full name"
                  disabled={formIsPhotoOnly}
                />
              </label>

              <label>
                Student ID
                <input
                  value={form.studentId}
                  onChange={(event) => {
                    setForm((prev) => ({ ...prev, studentId: event.target.value }));
                    setError("");
                  }}
                  placeholder="CSE2024001"
                  disabled={formIsPhotoOnly}
                />
              </label>

              <label>
                Program
                <select
                  value={form.program}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, program: event.target.value }))
                  }
                  disabled={formIsPhotoOnly}
                >
                  {PROGRAM_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Year
                <select
                  value={form.year}
                  onChange={(event) => setForm((prev) => ({ ...prev, year: event.target.value }))}
                  disabled={formIsPhotoOnly}
                >
                  {YEAR_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>

              <label className="editor-full">
                Phone (optional)
                <input
                  value={form.phone}
                  onChange={(event) => setForm((prev) => ({ ...prev, phone: event.target.value }))}
                  placeholder="9876543210"
                  disabled={formIsPhotoOnly}
                />
              </label>
            </div>

            <div className="capture-zone-wrap">
              <div
                className="upload-zone"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  void onUploadFiles(event.dataTransfer.files);
                }}
              >
                <p>Upload 3-5 JPG or PNG photos</p>
                <p className="muted">Drag and drop or select multiple files at once</p>
                <button
                  type="button"
                  className="camera-remove-btn"
                  onClick={() => uploadInputRef.current?.click()}
                >
                  Select Photos
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

              <div className="upload-preview">
                {previewUrl ? (
                  <img src={previewUrl} alt="Latest capture preview" />
                ) : (
                  <div className="upload-preview-empty">No preview yet</div>
                )}
              </div>
            </div>

            {uploadResults.length > 0 ? (
              <div className="upload-results">
                {uploadResults.map((result, index) => (
                  <p key={`${result.name}-${index}`} className={result.success ? "upload-ok" : "upload-fail"}>
                    {result.success ? "Detected" : "Failed"}: {result.name}
                    {result.reason ? ` - ${result.reason}` : ""}
                  </p>
                ))}
              </div>
            ) : null}

            <div className="webcam-capture">
              <div className="webcam-head">
                <p>Live capture</p>
                <p className="muted">
                  {autoCaptureRunning
                    ? `Step ${autoCaptureStepIndex + 1}/${AUTO_CAPTURE_STEPS.length}`
                    : autoCaptureCompleted
                      ? "Sequence complete"
                      : "Ready"}
                </p>
              </div>
              <p className="capture-instruction">{captureInstruction}</p>
              <p className="capture-progress-text">
                {AUTO_CAPTURE_STEPS.map((_, index) => (index < autoCapturedCount ? "●" : "○")).join(" ")}
              </p>
              {showWebcamPreview ? (
                <div className="webcam-wrap">
                  <video ref={captureVideoRef} className="register-video" playsInline muted autoPlay />
                  <svg className="face-guide-overlay" viewBox="0 0 100 100" aria-hidden="true">
                    <ellipse cx="50" cy="50" rx="26" ry="34" />
                  </svg>
                  <div className={`capture-flash ${captureFlash ? "active" : ""}`} />
                  {captureCountdown > 0 ? <div className="countdown-chip">{captureCountdown}</div> : null}
                </div>
              ) : (
                <div className="webcam-placeholder">Click Start Face Capture to open webcam preview.</div>
              )}
              <div className="editor-actions">
                <button
                  type="button"
                  className="action-btn"
                  onClick={() => {
                    setShowWebcamPreview(true);
                    void startAutoFaceCapture();
                  }}
                  disabled={busy || autoCaptureRunning}
                >
                  Start Face Capture
                </button>
                {autoCaptureRunning ? (
                  <button
                    type="button"
                    className="camera-remove-btn"
                    onClick={stopAutoCapture}
                  >
                    Stop Capture
                  </button>
                ) : null}
              </div>
            </div>

            <div className="thumb-head">
              <p>
                Face photos: {draftPhotos.length}/{MAX_FACE_PHOTOS}
              </p>
            </div>
            <div className="thumb-grid">
              {draftPhotos.map((photo) => (
                <figure key={photo.id} className="thumb-item">
                  <img src={photo.dataUrl} alt="Face capture" />
                </figure>
              ))}
              {draftPhotos.length === 0 ? <p className="muted">No face photos added yet.</p> : null}
            </div>

            <div className="editor-actions">
              <button type="button" className="action-btn" onClick={saveRegistration} disabled={busy}>
                {mode === "create" ? "Register Student" : mode === "edit" ? "Save Info" : "Save Photos"}
              </button>
              <button
                type="button"
                className="camera-remove-btn"
                onClick={() => {
                  void syncingEngineFromRegistry(registry);
                  resetEditor();
                  setSuccess("");
                }}
              >
                Discard
              </button>
              <button
                type="button"
                className="camera-remove-btn"
                onClick={() => {
                  resetEditor();
                  setSuccess("");
                }}
              >
                New Registration
              </button>
            </div>

            {error ? <p className="error-text">{error}</p> : null}
            {success ? <p className="success-text">{success}</p> : null}
            {consistencyReport ? (
              <div className="consistency-panel">
                <p className="consistency-title">Recognition confidence:</p>
                <div className="consistency-bar-track">
                  <div
                    className={`consistency-bar ${consistencyReport.tone}`}
                    style={{ width: `${consistencyReport.confidencePct}%` }}
                  />
                </div>
                <p className={`consistency-label ${consistencyReport.tone}`}>
                  Consistency score: {consistencyReport.label}
                </p>
                <small>Average inter-descriptor distance: {consistencyReport.averageDistance}</small>
              </div>
            ) : null}
            {hydrating ? <p className="muted">Loading face models...</p> : null}
          </section>

          <section className="registry-list-panel">
            <h4>Registered People</h4>
            <div className="registry-list">
              {registry.length === 0 ? <p className="muted">No registered people yet.</p> : null}
              {registry.map((entry) => {
                const status = statusFromStudentsMap(statusMap, entry.studentId);

                return (
                  <article key={entry.studentId} className="registry-card">
                    <div className="registry-head">
                      <div>
                        <strong>{entry.fullName}</strong>
                        <p className="muted">{entry.studentId}</p>
                      </div>
                      <span className={`status-badge ${status}`}>{status}</span>
                    </div>

                    <div className="registry-meta">
                      <p>{entry.program}</p>
                      <p>Year {entry.year}</p>
                      <p>{entry.photos.length} face photos</p>
                    </div>

                    <div className="registry-buttons">
                      <button
                        type="button"
                        className="camera-remove-btn"
                        onClick={() => openEditor(entry, "edit")}
                      >
                        Edit Info
                      </button>
                      <button
                        type="button"
                        className="camera-remove-btn"
                        onClick={() => openEditor(entry, "photos")}
                      >
                        Add More Photos
                      </button>
                      <button
                        type="button"
                        className="camera-remove-btn"
                        onClick={() => {
                          void removeRecord(entry);
                        }}
                        disabled={busy}
                      >
                        Remove
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>

            <div className="registry-danger-zone">
              <p className="danger-zone-title">Danger Zone</p>
              <p className="muted">Use this only to remove test entries like tempp/dds.</p>
              <button
                type="button"
                className="danger-btn"
                onClick={() => {
                  void clearAllData();
                }}
                disabled={busy}
              >
                Clear All Data
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
