import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
    <section className="panel map-wrap">
      <div className="map-head">
        <h3>Campus Map</h3>
        <div className="map-head-actions">
          <button
            type="button"
            className={`map-action-btn${isSettingCampusCenter ? " active" : ""}`}
            onClick={() => {
              setIsSettingCampusCenter((prev) => !prev);
              activateMap();
            }}
          >
            {isSettingCampusCenter ? "Cancel" : "Set Campus Location"}
          </button>
          <div className="legend">
            <span><i className="dot online"></i>Online</span>
            <span><i className="dot alert"></i>Alert</span>
            <span><i className="dot offline"></i>Offline</span>
          </div>
        </div>
      </div>
      {isSettingCampusCenter ? (
        <p className="map-setting-instruction">
          Click anywhere on the map to set your campus location
        </p>
      ) : null}
      <div
        ref={mapShellRef}
        className={`campus-map-shell${isMapActive ? " active" : ""}`}
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
          className="leaflet-map"
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

        {isMapActive ? (
          <div className="map-active-badge" role="status" aria-live="polite">
            Map active
          </div>
        ) : null}

        {!isMapActive ? (
          <div id="map-interaction-hint" className="map-interaction-hint" role="status" aria-live="polite">
            Click map to enable scroll zoom
          </div>
        ) : null}
      </div>
    </section>
  );
}
