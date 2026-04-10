import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { createPortal } from "react-dom";
import CameraFeed from "./CameraFeed";
import { createCameraPresenceHelper } from "../lib/cameraPresence";

const STORAGE_KEY = "omni:cameras:v2";
const DEFAULT_IP_PORT = "8080";
const BACKEND =
  import.meta.env.VITE_BACKEND_URL
  || import.meta.env.VITE_API_BASE
  || "http://localhost:5000";

const MJPEG_SOURCES = new Set([
  "ip-camera-lite-ios",
  "ip-webcam-android",
  "droidcam",
  "ip-other",
]);

function isMjpegSource(source) {
  return MJPEG_SOURCES.has(String(source || ""));
}

function stripHttpProtocol(value) {
  return String(value || "").replace(/^https?:\/\//i, "").trim();
}

function normalizeHostInput(value) {
  const stripped = stripHttpProtocol(value).split("/")[0].trim();
  if (!stripped) {
    return "";
  }

  if (stripped.includes(":")) {
    return stripped;
  }

  return `${stripped}:${DEFAULT_IP_PORT}`;
}

function normalizeFullUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `http://${trimmed}`;
}

function extractHostFromUrl(value) {
  const normalized = normalizeFullUrl(value);
  if (!normalized) {
    return "";
  }

  try {
    return new URL(normalized).host || "";
  } catch (error) {
    return "";
  }
}

function buildCameraUrls(source, value) {
  if (source === "ip-other") {
    const streamUrl = normalizeFullUrl(value);
    const snapshotUrl = streamUrl.includes("/video")
      ? streamUrl.replace("/video", "/jpeg")
      : streamUrl;

    return { streamUrl, snapshotUrl };
  }

  const host = normalizeHostInput(value);
  if (!host) {
    return { streamUrl: "", snapshotUrl: "" };
  }

  if (source === "ip-camera-lite-ios") {
    return {
      streamUrl: `http://${host}/video`,
      snapshotUrl: `http://${host}/jpeg`,
    };
  }

  if (source === "ip-webcam-android") {
    return {
      streamUrl: `http://${host}/video`,
      snapshotUrl: `http://${host}/shot.jpg`,
    };
  }

  if (source === "droidcam") {
    return {
      streamUrl: `http://${host}/mjpegfeed`,
      snapshotUrl: `http://${host}/shot.jpg`,
    };
  }

  return { streamUrl: "", snapshotUrl: "" };
}

function inferLegacyCameraUrls(
  source,
  ipAddress,
  existingStreamUrl = "",
  existingSnapshotUrl = ""
) {
  const normalizedSource = String(source || "") === "ip-webcam"
    ? "ip-webcam-android"
    : String(source || "");

  if (!isMjpegSource(normalizedSource)) {
    return { streamUrl: "", snapshotUrl: "" };
  }

  if (normalizedSource === "ip-other") {
    const streamUrl = normalizeFullUrl(existingStreamUrl || ipAddress);
    const snapshotUrl = normalizeFullUrl(
      existingSnapshotUrl ||
        (streamUrl.includes("/video") ? streamUrl.replace("/video", "/jpeg") : streamUrl)
    );

    return { streamUrl, snapshotUrl };
  }

  const host = normalizeHostInput(ipAddress) || extractHostFromUrl(existingStreamUrl);
  return buildCameraUrls(normalizedSource, host);
}

function buildPreviewUrl(source, value) {
  if (!isMjpegSource(source)) {
    return "";
  }

  return buildCameraUrls(source, value).streamUrl;
}

function buildPreviewTemplate(source) {
  if (source === "droidcam") {
    return "http://[IP]/mjpegfeed";
  }

  if (source === "ip-other") {
    return "http://[FULL_URL]";
  }

  return "http://[IP]/video";
}

function loadSavedCameras() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.map((camera) => {
      const sourceRaw = String(camera.source || "laptop-webcam");
      const source = sourceRaw === "ip-webcam" ? "ip-webcam-android" : sourceRaw;
      const ipAddress = String(camera.ipAddress || "");
      const streamUrlValue = String(camera.streamUrl || camera.mjpegUrl || "");
      const snapshotUrlValue = String(camera.snapshotUrl || "");
      const cameraUrls = inferLegacyCameraUrls(
        source,
        ipAddress,
        streamUrlValue,
        snapshotUrlValue
      );

      return {
        cameraId: String(camera.cameraId),
        cameraLabel: String(camera.cameraLabel || "Camera"),
        source,
        ipAddress,
        streamUrl: cameraUrls.streamUrl,
        snapshotUrl: cameraUrls.snapshotUrl,
        deviceId: String(camera.deviceId || ""),
        isActive: false,
      };
    });
  } catch (error) {
    return [];
  }
}

function buildCameraId() {
  return `cam-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

export default function CameraGrid({
  onDetection,
  emitEvent,
  socketConnected,
  onExpandedChange,
  suspendProcessing = false,
  detectionProfile = "ultra-fast",
  externalAddTrigger = 0,
}) {
  const [cameras, setCameras] = useState(() => loadSavedCameras());
  const [collapsed, setCollapsed] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [cameraType, setCameraType] = useState("laptop-webcam");
  const [cameraLabel, setCameraLabel] = useState("");
  const [ipAddress, setIpAddress] = useState("");
  const [webcamDevices, setWebcamDevices] = useState([]);
  const [selectedWebcamDeviceId, setSelectedWebcamDeviceId] = useState("");
  const [connectionTestStatus, setConnectionTestStatus] = useState("idle");
  const [connectionTestMessage, setConnectionTestMessage] = useState("");

  const previewUrl = useMemo(() => buildPreviewUrl(cameraType, ipAddress), [cameraType, ipAddress]);
  const previewTemplate = useMemo(() => buildPreviewTemplate(cameraType), [cameraType]);

  const streamsRef = useRef(new Map());
  const camerasRef = useRef(cameras);
  const presenceHelperRef = useRef(null);
  const externalAddHandledRef = useRef(externalAddTrigger);

  useEffect(() => {
    camerasRef.current = cameras;

    const saved = cameras.map((camera) => ({
      cameraId: camera.cameraId,
      cameraLabel: camera.cameraLabel,
      source: camera.source,
      ipAddress: camera.ipAddress,
      streamUrl: camera.streamUrl,
      snapshotUrl: camera.snapshotUrl,
      mjpegUrl: camera.streamUrl,
      deviceId: camera.deviceId,
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  }, [cameras]);

  const closeAddCameraModal = useCallback(() => {
    setShowModal(false);
    setConnectionTestStatus("idle");
    setConnectionTestMessage("");
  }, []);

  const openAddCameraModal = useCallback(() => {
    setShowModal(true);
    setConnectionTestStatus("idle");
    setConnectionTestMessage("");
  }, []);

  const refreshWebcamDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setWebcamDevices([]);
      setSelectedWebcamDeviceId("");
      return;
    }

    let tempStream = null;

    try {
      let devices = await navigator.mediaDevices.enumerateDevices();
      let videoInputs = devices.filter((device) => device.kind === "videoinput");

      const labelsMissing = videoInputs.length === 0 || videoInputs.every((device) => !device.label);
      if (labelsMissing && navigator.mediaDevices.getUserMedia) {
        tempStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        devices = await navigator.mediaDevices.enumerateDevices();
        videoInputs = devices.filter((device) => device.kind === "videoinput");
      }

      setWebcamDevices(videoInputs);
      setSelectedWebcamDeviceId((prev) => {
        if (prev && videoInputs.some((device) => device.deviceId === prev)) {
          return prev;
        }

        const iriunDevice = videoInputs.find((device) => /iriun/i.test(String(device.label || "")));
        return iriunDevice?.deviceId || videoInputs[0]?.deviceId || "";
      });
    } catch (error) {
      setWebcamDevices([]);
      setSelectedWebcamDeviceId("");
      setConnectionTestStatus("error");
      setConnectionTestMessage("Cannot access webcam devices. Allow camera permission in browser.");
    } finally {
      tempStream?.getTracks?.().forEach((track) => track.stop());
    }
  }, []);

  const getActiveCameraPayload = useCallback(() => {
    return camerasRef.current
      .filter((camera) => camera.isActive)
      .map((camera) => ({
        cameraId: camera.cameraId,
        cameraLabel: camera.cameraLabel,
        source: camera.source,
      }));
  }, []);

  useEffect(() => {
    presenceHelperRef.current = createCameraPresenceHelper({
      emitEvent,
      getActiveCameras: getActiveCameraPayload,
    });

    return () => {
      presenceHelperRef.current?.disconnectAll();
      presenceHelperRef.current?.cleanup();

      streamsRef.current.forEach((stream) => {
        stream.getTracks().forEach((track) => track.stop());
      });
      streamsRef.current.clear();
    };
  }, [emitEvent, getActiveCameraPayload]);

  useEffect(() => {
    if (socketConnected) {
      presenceHelperRef.current?.registerAll();
    }
  }, [socketConnected, cameras]);

  useEffect(() => {
    onExpandedChange?.(!collapsed);
  }, [collapsed, onExpandedChange]);

  useEffect(() => {
    if (externalAddTrigger === externalAddHandledRef.current) {
      return;
    }

    externalAddHandledRef.current = externalAddTrigger;
    openAddCameraModal();
  }, [externalAddTrigger, openAddCameraModal]);

  useEffect(() => {
    if (!showModal || cameraType !== "laptop-webcam") {
      return;
    }

    void refreshWebcamDevices();
  }, [cameraType, refreshWebcamDevices, showModal]);

  const setCameraActive = useCallback((cameraId, active) => {
    setCameras((prev) =>
      prev.map((camera) =>
        camera.cameraId === cameraId ? { ...camera, isActive: active } : camera
      )
    );
  }, []);

  const connectMediaStream = useCallback(
    async (camera) => {
      try {
        const preferredConstraints = camera.deviceId
          ? {
              video: {
                deviceId: { exact: camera.deviceId },
                width: { ideal: 1280 },
                height: { ideal: 720 },
              },
              audio: false,
            }
          : {
              video: {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                facingMode: { ideal: "user" },
              },
              audio: false,
            };

        let stream = null;
        let lastError = null;

        try {
          stream = await navigator.mediaDevices.getUserMedia(preferredConstraints);
        } catch (preferredError) {
          lastError = preferredError;

          const fallbackConstraints = [
            {
              video: {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                facingMode: { ideal: "user" },
              },
              audio: false,
            },
            { video: true, audio: false },
          ];

          for (const constraints of fallbackConstraints) {
            try {
              stream = await navigator.mediaDevices.getUserMedia(constraints);
              break;
            } catch (fallbackError) {
              lastError = fallbackError;
            }
          }
        }

        const videoTracks = stream?.getVideoTracks?.() || [];
        if (!stream || videoTracks.length === 0) {
          stream?.getTracks?.().forEach((track) => track.stop());
          throw lastError || new Error("No video tracks available");
        }

        streamsRef.current.set(camera.cameraId, stream);

        const activeDeviceId = stream.getVideoTracks()[0]?.getSettings?.().deviceId || "";
        if (activeDeviceId && activeDeviceId !== String(camera.deviceId || "")) {
          setCameras((prev) =>
            prev.map((item) =>
              item.cameraId === camera.cameraId ? { ...item, deviceId: activeDeviceId } : item
            )
          );
        }

        setCameraActive(camera.cameraId, true);
        emitEvent("camera:register", {
          cameraId: camera.cameraId,
          cameraLabel: camera.cameraLabel,
          source: camera.source,
        });
      } catch (error) {
        setCameraActive(camera.cameraId, false);
        setConnectionTestStatus("error");
        setConnectionTestMessage("Cannot open webcam. Close other camera apps and allow browser access.");
      }
    },
    [emitEvent, setCameraActive]
  );

  const connectCamera = useCallback(
    async (camera) => {
      if (isMjpegSource(camera.source)) {
        setCameraActive(camera.cameraId, true);
        emitEvent("camera:register", {
          cameraId: camera.cameraId,
          cameraLabel: camera.cameraLabel,
          source: camera.source,
        });
        return;
      }

      await connectMediaStream(camera);
    },
    [connectMediaStream, emitEvent, setCameraActive]
  );

  useEffect(() => {
    const initial = camerasRef.current;
    initial.forEach((camera) => {
      void connectCamera(camera);
    });
  }, [connectCamera]);

  const handleTestConnection = useCallback(async () => {
    if (!previewUrl) {
      setConnectionTestStatus("error");
      setConnectionTestMessage("Cannot reach camera. Check WiFi.");
      return;
    }

    setConnectionTestStatus("testing");
    setConnectionTestMessage("Testing camera...");

    try {
      const response = await fetch(
        `${BACKEND}/api/proxy/test?url=${encodeURIComponent(previewUrl)}`
      );
      const payload = await response.json().catch(() => ({
        success: false,
        error: "Invalid test response",
      }));

      if (response.ok && payload.success) {
        setConnectionTestStatus("success");
        setConnectionTestMessage("Camera reachable ✓");
        return;
      }

      setConnectionTestStatus("error");
      setConnectionTestMessage(payload.error || "Cannot reach camera. Check WiFi.");
    } catch (error) {
      setConnectionTestStatus("error");
      setConnectionTestMessage("Cannot reach camera. Check WiFi.");
    }
  }, [previewUrl]);

  const handleAddCamera = async () => {
    const label = cameraLabel.trim() || `Camera ${cameras.length + 1}`;
    const urls = isMjpegSource(cameraType)
      ? buildCameraUrls(cameraType, ipAddress)
      : { streamUrl: "", snapshotUrl: "" };
    const normalizedHost =
      cameraType === "ip-other"
        ? stripHttpProtocol(ipAddress).split("/")[0].trim()
        : normalizeHostInput(ipAddress);

    if (isMjpegSource(cameraType) && connectionTestStatus !== "success") {
      setConnectionTestStatus("error");
      setConnectionTestMessage("Cannot reach camera. Check WiFi.");
      return;
    }

    const camera = {
      cameraId: buildCameraId(),
      cameraLabel: label,
      source: cameraType,
      ipAddress: isMjpegSource(cameraType) ? normalizedHost : "",
      streamUrl: urls.streamUrl,
      snapshotUrl: urls.snapshotUrl,
      mjpegUrl: urls.streamUrl,
      deviceId: cameraType === "laptop-webcam" ? selectedWebcamDeviceId : "",
      isActive: false,
    };

    if (isMjpegSource(camera.source) && !camera.streamUrl) {
      return;
    }

    setCameras((prev) => [...prev, camera]);
    closeAddCameraModal();
    setCameraLabel("");
    setIpAddress("");
    setCameraType("laptop-webcam");
    setSelectedWebcamDeviceId("");
    setConnectionTestStatus("idle");
    setConnectionTestMessage("");

    await connectCamera(camera);
  };

  const handleRemoveCamera = (cameraId) => {
    const stream = streamsRef.current.get(cameraId);
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      streamsRef.current.delete(cameraId);
    }

    setCameras((prev) => prev.filter((camera) => camera.cameraId !== cameraId));
    emitEvent("camera:disconnect", { cameraId });
  };

  const connectDisabled = isMjpegSource(cameraType)
    ? connectionTestStatus !== "success"
    : false;

  const modalNode = (
    <AnimatePresence>
      {showModal ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[3200] grid place-items-center bg-[#06090f]/80 px-4 backdrop-blur-sm"
          onClick={closeAddCameraModal}
        >
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.98 }}
            transition={{ duration: 0.24, ease: "easeOut" }}
            className="glass-card w-full max-w-xl rounded-2xl border border-white/15 bg-[#0f1520]/95 p-5"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-cyan-100">Add Camera</h3>
              <button
                type="button"
                className="rounded-lg border border-white/15 px-2 py-1 text-xs text-slate-300 transition hover:border-cyan-300/40 hover:text-cyan-100"
                onClick={closeAddCameraModal}
              >
                Close
              </button>
            </div>

            <div className="space-y-3">
              <label className="block space-y-1 text-sm text-slate-200">
                Camera Label
                <input
                  className="w-full rounded-xl border border-white/15 bg-white/[0.04] px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-cyan-300/50"
                  value={cameraLabel}
                  onChange={(event) => {
                    setCameraLabel(event.target.value);
                    setConnectionTestStatus("idle");
                    setConnectionTestMessage("");
                  }}
                  placeholder="Gate 1 / Library / Cafeteria"
                />
              </label>

              <label className="block space-y-1 text-sm text-slate-200">
                Camera Type
                <select
                  className="w-full rounded-xl border border-white/15 bg-white/[0.04] px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-cyan-300/50"
                  value={cameraType}
                  onChange={(event) => {
                    setCameraType(event.target.value);
                    setConnectionTestStatus("idle");
                    setConnectionTestMessage("");
                  }}
                >
                  <option value="laptop-webcam">Laptop / USB Webcam</option>
                  <option value="ip-camera-lite-ios">IP Camera Lite (iOS)</option>
                  <option value="ip-webcam-android">IP Webcam (Android)</option>
                  <option value="droidcam">DroidCam</option>
                  <option value="ip-other">Other - custom URL</option>
                </select>
              </label>

              {!isMjpegSource(cameraType) ? (
                <label className="block space-y-1 text-sm text-slate-200">
                  Webcam Device
                  <div className="flex items-center gap-2">
                    <select
                      className="w-full rounded-xl border border-white/15 bg-white/[0.04] px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-cyan-300/50"
                      value={selectedWebcamDeviceId}
                      onChange={(event) => setSelectedWebcamDeviceId(event.target.value)}
                    >
                      {webcamDevices.length === 0 ? (
                        <option value="">Default webcam</option>
                      ) : (
                        webcamDevices.map((device, index) => (
                          <option key={device.deviceId || `webcam-${index}`} value={device.deviceId}>
                            {device.label || `Webcam ${index + 1}`}
                          </option>
                        ))
                      )}
                    </select>

                    <button
                      type="button"
                      className="rounded-lg border border-white/15 bg-white/[0.04] px-3 py-2 text-xs font-semibold text-slate-200 transition hover:border-cyan-300/35 hover:text-cyan-100"
                      onClick={() => {
                        void refreshWebcamDevices();
                      }}
                    >
                      Refresh
                    </button>
                  </div>
                  <small className="block text-xs text-slate-400">
                    If you use Iriun Webcam, choose the device name that includes "Iriun".
                  </small>
                </label>
              ) : null}

              {isMjpegSource(cameraType) ? (
                <label className="block space-y-1 text-sm text-slate-200">
                  {cameraType === "ip-other" ? "Camera URL" : "IP Address"}
                  <input
                    className="w-full rounded-xl border border-white/15 bg-white/[0.04] px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-cyan-300/50"
                    value={ipAddress}
                    onChange={(event) => {
                      setIpAddress(event.target.value);
                      setConnectionTestStatus("idle");
                      setConnectionTestMessage("");
                    }}
                    placeholder={
                      cameraType === "ip-other"
                        ? "http://192.168.1.4:8081/video"
                        : "192.168.1.4:8081"
                    }
                  />
                  {cameraType !== "ip-other" ? (
                    <small className="block text-xs text-slate-400">
                      Supports 192.168.x.x or 192.168.x.x:port (default port {DEFAULT_IP_PORT}).
                    </small>
                  ) : (
                    <small className="block text-xs text-slate-400">Enter the full camera URL including http://</small>
                  )}
                  <small className="block text-xs text-slate-400">
                    Will connect to: {previewUrl || previewTemplate}
                  </small>

                  <button
                    type="button"
                    className="rounded-lg border border-cyan-300/35 bg-cyan-500/10 px-3 py-2 text-xs font-semibold text-cyan-100 transition hover:bg-cyan-400/20"
                    onClick={handleTestConnection}
                    disabled={!previewUrl || connectionTestStatus === "testing"}
                  >
                    {connectionTestStatus === "testing" ? "Testing..." : "Test Connection"}
                  </button>

                  {connectionTestStatus === "success" ? (
                    <small className="block text-xs text-emerald-300">Camera reachable ✓</small>
                  ) : null}

                  {connectionTestStatus === "error" ? (
                    <small className="block text-xs text-red-300">Cannot reach camera. Check WiFi.</small>
                  ) : null}

                  {connectionTestStatus === "error" && connectionTestMessage ? (
                    <small className="block text-xs text-slate-400">{connectionTestMessage}</small>
                  ) : null}
                </label>
              ) : null}

              <button
                type="button"
                className="neon-btn w-full justify-center"
                onClick={handleAddCamera}
                disabled={connectDisabled || connectionTestStatus === "testing"}
              >
                Connect Camera
              </button>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="panel-title">Camera Surveillance Grid</h3>
          <p className="panel-kicker">2-column command view</p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-xl border border-white/15 bg-white/[0.05] px-3 py-2 text-xs font-semibold text-slate-200 transition hover:border-cyan-300/35 hover:text-cyan-100"
            onClick={() => setCollapsed((prev) => !prev)}
          >
            {collapsed ? "Expand" : "Collapse"}
          </button>
          <button type="button" className="neon-btn" onClick={openAddCameraModal}>
            + Add Camera
          </button>
        </div>
      </div>

      <div
        className={`grid grid-cols-1 gap-4 transition-all duration-300 md:grid-cols-2 ${
          collapsed ? "max-h-0 overflow-hidden opacity-0" : "opacity-100"
        }`}
      >
        <AnimatePresence initial={false} mode="popLayout">
          {cameras.length === 0 ? (
            <motion.div
              key="camera-empty"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="glass-card col-span-full grid min-h-[220px] place-items-center rounded-2xl border border-white/10 bg-white/[0.04] text-center"
            >
              <div>
                <p className="text-sm font-medium text-slate-200">No cameras connected</p>
                <p className="mt-1 text-xs text-slate-400">Use Add Camera to attach a live source.</p>
              </div>
            </motion.div>
          ) : (
            cameras.map((camera, index) => (
              <motion.div
                key={camera.cameraId}
                layout
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.24, delay: index * 0.03, ease: "easeOut" }}
              >
                <CameraFeed
                  cameraId={camera.cameraId}
                  cameraLabel={camera.cameraLabel}
                  stream={streamsRef.current.get(camera.cameraId) || null}
                  sourceType={camera.source}
                  streamUrl={camera.streamUrl}
                  snapshotUrl={camera.snapshotUrl}
                  isActive={camera.isActive}
                  suspendProcessing={suspendProcessing}
                  detectionProfile={detectionProfile}
                  onDetection={onDetection}
                  onRemove={() => handleRemoveCamera(camera.cameraId)}
                />
              </motion.div>
            ))
          )}
        </AnimatePresence>
      </div>

      {typeof document !== "undefined" ? createPortal(modalNode, document.body) : modalNode}
    </section>
  );
}
