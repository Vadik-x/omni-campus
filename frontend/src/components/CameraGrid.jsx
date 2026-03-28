import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CameraFeed from "./CameraFeed";
import { createCameraPresenceHelper } from "../lib/cameraPresence";

const STORAGE_KEY = "omni:cameras:v2";
const DEFAULT_IP_PORT = "8080";
const BACKEND = import.meta.env.VITE_BACKEND_URL || "http://localhost:5000";

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
}) {
  const [cameras, setCameras] = useState(() => loadSavedCameras());
  const [collapsed, setCollapsed] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [cameraType, setCameraType] = useState("laptop-webcam");
  const [cameraLabel, setCameraLabel] = useState("");
  const [ipAddress, setIpAddress] = useState("");
  const [connectionTestStatus, setConnectionTestStatus] = useState("idle");
  const [connectionTestMessage, setConnectionTestMessage] = useState("");

  const previewUrl = useMemo(() => buildPreviewUrl(cameraType, ipAddress), [cameraType, ipAddress]);
  const previewTemplate = useMemo(() => buildPreviewTemplate(cameraType), [cameraType]);

  const streamsRef = useRef(new Map());
  const camerasRef = useRef(cameras);
  const presenceHelperRef = useRef(null);

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
        const constraints = { video: true, audio: false };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        streamsRef.current.set(camera.cameraId, stream);
        setCameraActive(camera.cameraId, true);
        emitEvent("camera:register", {
          cameraId: camera.cameraId,
          cameraLabel: camera.cameraLabel,
          source: camera.source,
        });
      } catch (error) {
        setCameraActive(camera.cameraId, false);
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
      connectCamera(camera);
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
      deviceId: "",
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

  const layoutClass = useMemo(() => {
    if (cameras.length <= 1) {
      return "single";
    }

    if (cameras.length === 2) {
      return "double";
    }

    return "multi";
  }, [cameras.length]);

  const gridStyle = useMemo(() => {
    if (collapsed) {
      return {
        height: "0px",
        maxHeight: "0px",
        gridTemplateColumns: "1fr",
      };
    }

    if (cameras.length <= 1) {
      return {
        gridTemplateColumns: "1fr",
        height: "100%",
        maxHeight: "100%",
      };
    }

    if (cameras.length === 2) {
      return {
        gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
        height: "100%",
        maxHeight: "100%",
      };
    }

    return {
      gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
      height: "100%",
      maxHeight: "100%",
    };
  }, [cameras.length, collapsed]);

  const connectDisabled = isMjpegSource(cameraType)
    ? connectionTestStatus !== "success"
    : false;

  return (
    <section className="camera-grid-shell">
      <div className="camera-grid-head">
        <h3>Active Cameras</h3>
        <div className="camera-grid-actions">
          <button
            type="button"
            className="camera-remove-btn"
            onClick={() => setCollapsed((prev) => !prev)}
          >
            {collapsed ? "Expand" : "Collapse"}
          </button>
          <button type="button" className="action-btn" onClick={openAddCameraModal}>
            + Add Camera
          </button>
        </div>
      </div>

      <div className={`camera-grid ${layoutClass} ${collapsed ? "collapsed" : ""}`} style={gridStyle}>
        {cameras.length === 0 ? (
          <div className="panel camera-empty">No cameras added yet.</div>
        ) : (
          cameras.map((camera) => (
            <CameraFeed
              key={camera.cameraId}
              cameraId={camera.cameraId}
              cameraLabel={camera.cameraLabel}
              stream={streamsRef.current.get(camera.cameraId) || null}
              sourceType={camera.source}
              streamUrl={camera.streamUrl}
              snapshotUrl={camera.snapshotUrl}
              isActive={camera.isActive}
              onDetection={onDetection}
              onRemove={() => handleRemoveCamera(camera.cameraId)}
            />
          ))
        )}
      </div>

      {showModal ? (
        <div className="modal-backdrop camera-backdrop" onClick={closeAddCameraModal}>
          <div className="modal-card camera-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h3>Add Camera</h3>
              <button type="button" className="close-btn" onClick={closeAddCameraModal}>
                X
              </button>
            </div>

            <div className="camera-modal-body">
              <label>
                Camera Label
                <input
                  value={cameraLabel}
                  onChange={(event) => {
                    setCameraLabel(event.target.value);
                    setConnectionTestStatus("idle");
                    setConnectionTestMessage("");
                  }}
                  placeholder="Gate 1 / Library / Cafeteria"
                />
              </label>

              <label>
                Camera Type
                <select
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

              {isMjpegSource(cameraType) ? (
                <label>
                  {cameraType === "ip-other" ? "Camera URL" : "IP Address"}
                  <input
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
                    <small className="muted">
                      Supports 192.168.x.x or 192.168.x.x:port (default port {DEFAULT_IP_PORT}).
                    </small>
                  ) : (
                    <small className="muted">Enter the full camera URL including http://</small>
                  )}
                  <small className="muted">
                    Will connect to: {previewUrl || previewTemplate}
                  </small>

                  <button
                    type="button"
                    className="camera-remove-btn"
                    onClick={handleTestConnection}
                    disabled={!previewUrl || connectionTestStatus === "testing"}
                  >
                    {connectionTestStatus === "testing" ? "Testing..." : "Test Connection"}
                  </button>

                  {connectionTestStatus === "success" ? (
                    <small className="success-text">Camera reachable ✓</small>
                  ) : null}

                  {connectionTestStatus === "error" ? (
                    <small className="error-text">Cannot reach camera. Check WiFi.</small>
                  ) : null}

                  {connectionTestStatus === "error" && connectionTestMessage ? (
                    <small className="muted">{connectionTestMessage}</small>
                  ) : null}
                </label>
              ) : null}

              <button
                type="button"
                className="action-btn"
                onClick={handleAddCamera}
                disabled={connectDisabled || connectionTestStatus === "testing"}
              >
                Connect Camera
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
