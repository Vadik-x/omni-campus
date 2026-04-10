import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import L from "leaflet";
import {
  CircleMarker,
  MapContainer,
  Marker,
  Popup,
  TileLayer,
  useMap,
  useMapEvents,
} from "react-leaflet";

// Updated for RKGIT, Ghaziabad.
const DEFAULT_MAP_CENTER = [28.6967, 77.4988];
const DEFAULT_ZOOM_LEVEL = 15;
const MAP_IDLE_TIMEOUT_MS = 7000;
const CAMERA_POSITION_OFFSETS = [
  [0.0003, -0.0002],
  [-0.0002, 0.00022],
  [0.00018, 0.00028],
  [-0.00028, -0.00016],
  [0.00034, 0.00006],
];

const CAMPUS_ICON = L.divIcon({
  className: "map-icon-wrap campus-icon-wrap",
  html: '<span aria-hidden="true">🏫</span>',
  iconSize: [28, 28],
  iconAnchor: [14, 14],
  popupAnchor: [0, -14],
});

const CAMERA_ICON = L.divIcon({
  className: "map-icon-wrap camera-icon-wrap",
  html: '<span aria-hidden="true">📷</span>',
  iconSize: [24, 24],
  iconAnchor: [12, 12],
  popupAnchor: [0, -12],
});

function normalizePoint(value, fallback = DEFAULT_MAP_CENTER) {
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

function statusColor(status = "offline") {
  if (status === "online") {
    return "#37ff8b";
  }
  if (status === "alert") {
    return "#ffb547";
  }
  return "#71808f";
}

function fallbackPoint(index, center = DEFAULT_MAP_CENTER) {
  const [offsetLat, offsetLng] =
    CAMERA_POSITION_OFFSETS[index % CAMERA_POSITION_OFFSETS.length];
  return [
    Number((center[0] + offsetLat).toFixed(6)),
    Number((center[1] + offsetLng).toFixed(6)),
  ];
}

function cameraPoint(camera, index, cameraLocations = {}, center = DEFAULT_MAP_CENTER) {
  const cameraId = String(camera?.cameraId || `camera-${index + 1}`);
  const cameraLabel = String(camera?.cameraLabel || `Camera ${index + 1}`);

  if (cameraLocations[cameraId]) {
    return normalizePoint(cameraLocations[cameraId], center);
  }

  if (cameraLocations[cameraLabel]) {
    return normalizePoint(cameraLocations[cameraLabel], center);
  }

  return fallbackPoint(index, center);
}

function studentPoint(student, cameraLocations = {}, center = DEFAULT_MAP_CENTER) {
  const buildingId = student.currentLocation?.buildingId;
  const buildingName = student.currentLocation?.buildingName;

  if (buildingId && cameraLocations[buildingId]) {
    return normalizePoint(cameraLocations[buildingId], center);
  }

  if (buildingName && cameraLocations[buildingName]) {
    return normalizePoint(cameraLocations[buildingName], center);
  }

  return [center[0], center[1]];
}

function CampusCenterClickHandler({ enabled, onPick }) {
  useMapEvents({
    click(event) {
      if (!enabled || typeof onPick !== "function") {
        return;
      }

      onPick([event.latlng.lat, event.latlng.lng]);
    },
  });

  return null;
}

function MapCenterSync({ center }) {
  const map = useMap();

  useEffect(() => {
    const target = normalizePoint(center, DEFAULT_MAP_CENTER);
    map.setView(target, map.getZoom(), { animate: true });
  }, [center, map]);

  return null;
}

export default function CampusMap({
  students,
  onSelectStudent,
  cameraLocations = {},
  cameras = [],
  campusCenter = DEFAULT_MAP_CENTER,
  zoomLevel = DEFAULT_ZOOM_LEVEL,
  onCampusCenterChange,
  onCameraPositionChange,
  isExpanded = true,
}) {
  const mapInstance = useRef(null);
  const mapShellRef = useRef(null);
  const idleTimerRef = useRef(null);
  const [mapReadyToken, setMapReadyToken] = useState(0);
  const [isMapActive, setIsMapActive] = useState(false);
  const [isSettingCampusCenter, setIsSettingCampusCenter] = useState(false);

  const safeCampusCenter = useMemo(
    () => normalizePoint(campusCenter, DEFAULT_MAP_CENTER),
    [campusCenter]
  );

  const cameraMarkers = useMemo(() => {
    return cameras.map((camera, index) => {
      const cameraId = String(camera?.cameraId || `camera-${index + 1}`);
      const cameraLabel = String(camera?.cameraLabel || `Camera ${index + 1}`);

      return {
        cameraId,
        cameraLabel,
        position: cameraPoint(camera, index, cameraLocations, safeCampusCenter),
      };
    });
  }, [cameraLocations, cameras, safeCampusCenter]);

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  const disableMapInteractions = useCallback(() => {
    const map = mapInstance.current;
    if (!map) {
      return;
    }

    map.scrollWheelZoom.disable();
    map.dragging.disable();
    map.touchZoom.disable();
    map.doubleClickZoom.disable();
    map.boxZoom.disable();
    map.keyboard.disable();

    if (map.tap && typeof map.tap.disable === "function") {
      map.tap.disable();
    }
  }, []);

  const enableMapInteractions = useCallback(() => {
    const map = mapInstance.current;
    if (!map) {
      return;
    }

    map.scrollWheelZoom.enable();
    map.dragging.enable();
    map.touchZoom.enable();
    map.doubleClickZoom.enable();
    map.boxZoom.enable();
    map.keyboard.enable();

    if (map.tap && typeof map.tap.enable === "function") {
      map.tap.enable();
    }
  }, []);

  const deactivateMap = useCallback(() => {
    disableMapInteractions();
    setIsMapActive(false);
    clearIdleTimer();
  }, [clearIdleTimer, disableMapInteractions]);

  const scheduleIdleDeactivation = useCallback(() => {
    clearIdleTimer();
    idleTimerRef.current = window.setTimeout(() => {
      deactivateMap();
    }, MAP_IDLE_TIMEOUT_MS);
  }, [clearIdleTimer, deactivateMap]);

  const activateMap = useCallback(() => {
    enableMapInteractions();
    setIsMapActive(true);
    scheduleIdleDeactivation();
  }, [enableMapInteractions, scheduleIdleDeactivation]);

  useEffect(() => {
    if (!mapInstance.current) {
      return undefined;
    }

    const frameId = requestAnimationFrame(() => {
      mapInstance.current?.invalidateSize();
    });

    return () => cancelAnimationFrame(frameId);
  }, [cameraMarkers.length, isExpanded, students.length, cameraLocations]);

  useEffect(() => {
    const map = mapInstance.current;
    const mapShell = mapShellRef.current;
    if (!map || !mapShell || typeof ResizeObserver === "undefined") {
      return undefined;
    }

    let frameId = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => {
        map.invalidateSize();
      });
    });

    observer.observe(mapShell);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frameId);
    };
  }, [mapReadyToken]);

  useEffect(() => {
    const mapShell = mapShellRef.current;
    if (!mapShell) {
      return undefined;
    }

    const handleDocumentPointerDown = (event) => {
      if (!mapShell.contains(event.target)) {
        deactivateMap();
      }
    };

    document.addEventListener("pointerdown", handleDocumentPointerDown);

    return () => {
      document.removeEventListener("pointerdown", handleDocumentPointerDown);
    };
  }, [deactivateMap]);

  useEffect(() => {
    const mapShell = mapShellRef.current;
    if (!mapShell || !isMapActive) {
      return undefined;
    }

    const handleActivity = () => {
      scheduleIdleDeactivation();
    };

    mapShell.addEventListener("pointerdown", handleActivity, { passive: true });
    mapShell.addEventListener("wheel", handleActivity, { passive: true });
    mapShell.addEventListener("touchstart", handleActivity, { passive: true });
    mapShell.addEventListener("keydown", handleActivity);

    return () => {
      mapShell.removeEventListener("pointerdown", handleActivity);
      mapShell.removeEventListener("wheel", handleActivity);
      mapShell.removeEventListener("touchstart", handleActivity);
      mapShell.removeEventListener("keydown", handleActivity);
    };
  }, [isMapActive, scheduleIdleDeactivation]);

  useEffect(() => {
    return () => {
      clearIdleTimer();
      disableMapInteractions();
    };
  }, [clearIdleTimer, disableMapInteractions]);

  const handleMapKeyDown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activateMap();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      deactivateMap();
    }
  };

  const handleCampusLocationPick = useCallback(
    (nextPoint) => {
      const normalized = normalizePoint(nextPoint, safeCampusCenter);
      if (typeof onCampusCenterChange === "function") {
        onCampusCenterChange(normalized);
      }

      setIsSettingCampusCenter(false);

      const map = mapInstance.current;
      if (map) {
        map.setView(normalized, map.getZoom(), { animate: true });
      }
    },
    [onCampusCenterChange, safeCampusCenter]
  );

  const handleCameraDragEnd = useCallback(
    (camera, event) => {
      const latLng = event?.target?.getLatLng?.();
      if (!latLng) {
        return;
      }

      if (typeof onCameraPositionChange === "function") {
        onCameraPositionChange({
          cameraId: camera.cameraId,
          cameraLabel: camera.cameraLabel,
          position: [latLng.lat, latLng.lng],
        });
      }
    },
    [onCameraPositionChange]
  );

  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: "easeOut" }}
      className="glass-card rounded-2xl border border-white/10 bg-white/[0.05] p-4"
    >
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="panel-title">Campus Map</h3>
          <p className="panel-kicker">Geo surveillance layer</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={`rounded-xl border px-3 py-2 text-xs font-semibold transition ${
              isSettingCampusCenter
                ? "border-cyan-300/60 bg-cyan-500/20 text-cyan-100"
                : "border-white/15 bg-white/[0.04] text-slate-200 hover:border-cyan-300/35 hover:text-cyan-100"
            }`}
            onClick={() => {
              setIsSettingCampusCenter((prev) => !prev);
              activateMap();
            }}
          >
            {isSettingCampusCenter ? "Cancel" : "Set Campus Location"}
          </button>

          <div className="flex items-center gap-3 text-[11px] text-slate-300">
            <span className="inline-flex items-center gap-1.5">
              <i className="h-2 w-2 rounded-full bg-emerald-300 shadow-[0_0_8px_rgba(110,231,183,0.95)]" />
              Online
            </span>
            <span className="inline-flex items-center gap-1.5">
              <i className="h-2 w-2 rounded-full bg-amber-300 shadow-[0_0_8px_rgba(252,211,77,0.95)]" />
              Alert
            </span>
            <span className="inline-flex items-center gap-1.5">
              <i className="h-2 w-2 rounded-full bg-slate-400" />
              Offline
            </span>
          </div>
        </div>
      </div>

      {isSettingCampusCenter ? (
        <p className="mb-2 text-xs text-cyan-200/80">
          Click anywhere on the map to set your campus location
        </p>
      ) : null}

      <div
        ref={mapShellRef}
        className={`relative h-[360px] overflow-hidden rounded-2xl border transition-all md:h-[420px] ${
          isMapActive
            ? "border-cyan-300/55 shadow-neon"
            : "border-white/10"
        }`}
        tabIndex={0}
        role="region"
        aria-label="Campus map. Click or press Enter to interact, and press Escape to exit map interaction mode."
        aria-describedby="map-interaction-hint"
        onClick={activateMap}
        onKeyDown={handleMapKeyDown}
      >
        <MapContainer
          center={safeCampusCenter}
          zoom={zoomLevel}
          className="h-full w-full"
          zoomControl={false}
          scrollWheelZoom={false}
          dragging={false}
          touchZoom={false}
          doubleClickZoom={false}
          boxZoom={false}
          keyboard={false}
          whenReady={(event) => {
            mapInstance.current = event.target;
            disableMapInteractions();
            setMapReadyToken((prev) => prev + 1);
          }}
        >
          <MapCenterSync center={safeCampusCenter} />
          <CampusCenterClickHandler
            enabled={isSettingCampusCenter}
            onPick={handleCampusLocationPick}
          />

          <TileLayer
            attribution='&copy; OpenStreetMap &copy; CARTO'
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          />

          <Marker position={safeCampusCenter} icon={CAMPUS_ICON}>
            <Popup>
              <strong>Campus Center</strong>
              <br />
              {safeCampusCenter[0].toFixed(5)}, {safeCampusCenter[1].toFixed(5)}
            </Popup>
          </Marker>

          {cameraMarkers.map((camera, index) => (
            <Marker
              key={`${camera.cameraId}-${index}`}
              position={camera.position}
              icon={CAMERA_ICON}
              draggable
              eventHandlers={{
                dragend: (event) => handleCameraDragEnd(camera, event),
              }}
            >
              <Popup>
                <strong>{camera.cameraLabel}</strong>
                <br />
                Drag to set camera position
              </Popup>
            </Marker>
          ))}

          {students.map((student) => {
            const position = studentPoint(student, cameraLocations, safeCampusCenter);
            return (
              <CircleMarker
                key={student.studentId}
                center={position}
                radius={8}
                pathOptions={{
                  color: "#d9f6ff",
                  weight: 1,
                  fillColor: statusColor(student.status),
                  fillOpacity: 0.95,
                }}
                eventHandlers={{
                  click: () => onSelectStudent(student.studentId),
                }}
              >
                <Popup>
                  <strong>{student.name}</strong>
                  <br />
                  {student.program}
                  <br />
                  {student.currentLocation?.buildingName || "Unknown"}
                </Popup>
              </CircleMarker>
            );
          })}
        </MapContainer>

        <div className="pointer-events-none absolute inset-0 z-[390] bg-gradient-to-br from-cyan-500/5 via-transparent to-violet-500/10 backdrop-blur-[1px]" />

        {isMapActive ? (
          <div
            className="absolute right-3 top-3 z-[620] rounded-full bg-cyan-500/25 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-cyan-100"
            role="status"
            aria-live="polite"
          >
            Map active
          </div>
        ) : null}

        {!isMapActive ? (
          <div
            id="map-interaction-hint"
            className="absolute bottom-3 left-1/2 z-[620] -translate-x-1/2 rounded-full border border-cyan-300/35 bg-[#0a1320]/80 px-3 py-1 text-xs text-cyan-100"
            role="status"
            aria-live="polite"
          >
            Click map to enable scroll zoom
          </div>
        ) : null}
      </div>
    </motion.section>
  );
}
