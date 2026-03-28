import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { faceEngine } from "../lib/faceEngine";

const DETECTION_INTERVAL_MS = 1500;
const MJPEG_DETECTION_INTERVAL_MS = 2000;
const DRAW_FRAME_INTERVAL_MS = 1000 / 30;
const DETECTION_HOLD_MS = 800;
const MJPEG_CONNECT_TIMEOUT_MS = 8000;
const DETECTION_COOLDOWN_MS = 15000;
const MJPEG_WIDTH = 640;
const MJPEG_HEIGHT = 480;
const BACKEND = import.meta.env.VITE_BACKEND_URL || "http://localhost:5000";

const proxyUrl = (camUrl) =>
  `${BACKEND}/api/proxy/stream?url=${encodeURIComponent(String(camUrl || ""))}`;

const snapshotUrl = (camUrl) =>
  `${BACKEND}/api/proxy/snapshot?url=${encodeURIComponent(String(camUrl || ""))}`;

function getStatusPriority(statusType) {
  if (statusType === "identified") {
    return 4;
  }
  if (statusType === "temporal") {
    return 3;
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
  sourceType = "laptop-webcam",
  streamUrl: cameraStreamUrl = "",
  snapshotUrl: cameraSnapshotUrl = "",
  onRemove,
}) {
  const videoRef = useRef(null);
  const visibleMjpegRef = useRef(null);
  const overlayCanvasRef = useRef(null);

  const lastDetectionsRef = useRef([]);
  const detectBusyRef = useRef(false);
  const emitCooldownRef = useRef(new Map());
  const lastDrawFrameAtRef = useRef(0);

  const [isConnecting, setIsConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const [retryNonce, setRetryNonce] = useState(0);
  const [mjpegReady, setMjpegReady] = useState(false);
  const [isDetecting, setIsDetecting] = useState(false);
  const [statusInfo, setStatusInfo] = useState({ type: "idle", text: "No face detected" });

  const isMjpegSource = Boolean(cameraStreamUrl) && sourceType !== "laptop-webcam";

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
    if (!video || !stream) {
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
  }, [isMjpegSource, stream]);

  useEffect(() => {
    if (!isMjpegSource || !isActive || !proxiedStreamUrl) {
      setIsConnecting(false);
      setConnectionError("");
      setMjpegReady(false);
      return undefined;
    }

    setIsConnecting(true);
    setConnectionError("");
    setMjpegReady(false);
    setStatusInfo({ type: "idle", text: "No face detected" });
    lastDetectionsRef.current = [];
  }, [isActive, isMjpegSource, proxiedStreamUrl]);

  useEffect(() => {
    if (!isMjpegSource || !isActive || !proxiedStreamUrl || !isConnecting || mjpegReady || connectionError) {
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

  useEffect(() => {
    let rafId = 0;

    const draw = (timestamp) => {
      if (timestamp - lastDrawFrameAtRef.current < DRAW_FRAME_INTERVAL_MS) {
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
        (item) => now - item.lastSeenAt <= DETECTION_HOLD_MS
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

        const label = String(item.displayLabel || item.match?.name || "Unknown");
        const labelColor = String(item.boxColor || "#ffd447");

        ctx.lineWidth = 2.5;
        ctx.strokeStyle = labelColor;
        ctx.setLineDash(item.boxDashed ? [8, 6] : []);
        ctx.strokeRect(x, y, w, h);
        ctx.setLineDash([]);

        ctx.font = "600 13px Segoe UI";
        const nameWidth = ctx.measureText(label).width;
        const labelTop = Math.max(0, y - 24);
        const labelTextY = Math.max(14, y - 8);

        ctx.fillStyle = "rgba(0,0,0,0.7)";
        ctx.fillRect(x, labelTop, nameWidth + 8, 22);
        ctx.fillStyle = labelColor;
        ctx.fillText(label, x + 4, labelTextY);
      });

      rafId = requestAnimationFrame(draw);
    };

    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, [isMjpegSource]);

  useEffect(() => {
    if (!isActive) {
      lastDetectionsRef.current = [];
      setStatusInfo({ type: "idle", text: "No face detected" });
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
          setStatusInfo({ type: "idle", text: "No face detected" });
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

        const results = isMjpegSource
          ? await faceEngine.processVideoFrame(source)
          : await faceEngine.processVideoFrame(source, {
              distanceMode,
              upscaleFactor: 2,
            });
        const now = Date.now();

        const normalized = results
          .map((item) => {
            const box = item?.box || item?.detection?.box;
            if (!box) {
              return null;
            }

            const statusType = ["identified", "temporal", "unknown"].includes(item?.statusType)
              ? item.statusType
              : item?.match
                ? "identified"
                : "unknown";

            const displayLabel = String(item?.displayLabel || item?.match?.name || "Unknown");

            const defaultColor = statusType === "identified" || statusType === "temporal"
              ? "#00ff88"
              : "#ffd447";

            return {
              match: item?.match || null,
              box,
              displayLabel,
              statusType,
              boxColor: String(item?.boxColor || defaultColor),
              boxDashed: Boolean(item?.boxDashed),
              shouldEmit: Boolean(item?.shouldEmit),
              emitConfidence: Number(item?.emitConfidence ?? item?.match?.confidence ?? 0),
              lastSeenAt: now,
            };
          })
          .filter(Boolean);

        if (normalized.length > 0) {
          lastDetectionsRef.current = normalized;
        }

        if (normalized.length === 0) {
          setStatusInfo({ type: "idle", text: "No face detected" });
        } else {
          const best = normalized.reduce((acc, current) => {
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
          const nextText = String(best?.displayLabel || (nextType === "unknown" ? "Unknown person" : "Face detected"));
          setStatusInfo({ type: nextType, text: nextText });
        }

        normalized.forEach((item) => {
          if (!item.match || !item.shouldEmit) {
            return;
          }

          const confidence = Number(item.emitConfidence ?? item.match.confidence ?? 0);
          if (!Number.isFinite(confidence) || confidence <= 0.45) {
            return;
          }

          const dedupeKey = `${cameraId}:${item.match.personId}`;
          const last = emitCooldownRef.current.get(dedupeKey) || 0;
          if (now - last < DETECTION_COOLDOWN_MS) {
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
      } catch (error) {
        if (isMjpegSource) {
          setConnectionError("Cannot reach camera. Check WiFi.");
          setStatusInfo({ type: "idle", text: "No face detected" });
        }
      } finally {
        detectBusyRef.current = false;
        setIsDetecting(false);
      }
    };

    const intervalMs = isMjpegSource ? MJPEG_DETECTION_INTERVAL_MS : DETECTION_INTERVAL_MS;
    const timer = setInterval(detect, intervalMs);
    detect();

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [
    cameraId,
    cameraLabel,
    isActive,
    isConnecting,
    isMjpegSource,
    loadSnapshotForDetection,
    mjpegReady,
    onDetection,
    proxiedSnapshotUrl,
  ]);

  const retryMjpegConnection = () => {
    setConnectionError("");
    setIsConnecting(true);
    setMjpegReady(false);
    setRetryNonce((prev) => prev + 1);
  };

  const hasConnectionError = Boolean(connectionError);

  const stateLabel = isMjpegSource
    ? hasConnectionError
      ? "Error"
      : isConnecting
        ? "Connecting"
        : "Live"
    : "Live";

  const statusTone = isDetecting
    ? "scanning"
    : statusInfo.type === "identified"
      ? "identified"
      : statusInfo.type === "temporal"
        ? "temporal"
        : statusInfo.type === "unknown"
          ? "unknown"
          : "idle";

  const statusText = isDetecting ? "Scanning..." : statusInfo.text;

  if (!isActive && !isMjpegSource) {
    return (
      <article className="camera-feed-card offline">
        <div className="camera-stage">
          <div className="camera-chip camera-label">{cameraLabel}</div>
          <div className="camera-chip camera-state">Offline</div>
          <div className="camera-offline">Camera Offline</div>
          <div className="camera-status-bar idle">No face detected</div>
        </div>
        {onRemove ? (
          <button type="button" className="camera-remove-btn" onClick={onRemove}>
            Remove
          </button>
        ) : null}
      </article>
    );
  }

  return (
    <article className="camera-feed-card">
      <div className="camera-stage">
        {isMjpegSource ? (
          <img
            ref={visibleMjpegRef}
            src={proxiedStreamUrl}
            alt={`${cameraLabel} MJPEG stream`}
            className="camera-mjpeg-image"
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
            onError={handleMjpegError}
            onLoad={handleMjpegLoad}
          />
        ) : (
          <video ref={videoRef} className="camera-video" playsInline muted autoPlay />
        )}

        <canvas ref={overlayCanvasRef} className="camera-overlay" />

        {isMjpegSource && isConnecting ? (
          <div className="camera-connecting">
            <div className="camera-spinner" />
            <p>Connecting to camera...</p>
          </div>
        ) : null}

        {isMjpegSource && connectionError ? (
          <div className="camera-error">
            <pre>{connectionError}</pre>
            <button type="button" className="camera-retry-btn" onClick={retryMjpegConnection}>
              Retry
            </button>
          </div>
        ) : null}

        <div className="camera-chip camera-label">{cameraLabel}</div>
        <div className="camera-chip camera-state">{stateLabel}</div>
        <div className={`camera-status-bar ${statusTone}`}>{statusText}</div>
      </div>
      {onRemove ? (
        <button type="button" className="camera-remove-btn" onClick={onRemove}>
          Remove
        </button>
      ) : null}
    </article>
  );
}
