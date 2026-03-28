import { useCallback, useEffect, useRef, useState } from "react";
import { CircleMarker, MapContainer, Popup, TileLayer } from "react-leaflet";

const CAMPUS_CENTER = [12.9716, 77.5946];
const MAP_IDLE_TIMEOUT_MS = 7000;
const BUILDING_POINTS = {
  "Library - Block B": [12.97195, 77.5941],
  "Main Gate": [12.9709, 77.5949],
  "Admin Block": [12.9714, 77.5953],
  "Engineering Block": [12.9722, 77.5948],
  Hostel: [12.9725, 77.5938],
  Auditorium: [12.9712, 77.5937],
};

const DEFAULT_CAMERA_POINTS = {
  "Camera 1": [12.9719, 77.5942],
  "Camera 2": [12.9713, 77.5950],
  "Camera 3": [12.9723, 77.5939],
  "camera-1": [12.9719, 77.5942],
  "camera-2": [12.9713, 77.5950],
  "camera-3": [12.9723, 77.5939],
};

function statusColor(status = "offline") {
  if (status === "online") {
    return "#37ff8b";
  }
  if (status === "alert") {
    return "#ffb547";
  }
  return "#71808f";
}

function fallbackPoint(index) {
  const lat = CAMPUS_CENTER[0] + ((index % 6) - 3) * 0.00025;
  const lng = CAMPUS_CENTER[1] + ((index % 5) - 2) * 0.00022;
  return [lat, lng];
}

function studentPoint(student, index, cameraLocations = {}) {
  const buildingId = student.currentLocation?.buildingId;
  const buildingName = student.currentLocation?.buildingName;

  if (buildingId && cameraLocations[buildingId]) {
    return cameraLocations[buildingId];
  }

  if (buildingName && cameraLocations[buildingName]) {
    return cameraLocations[buildingName];
  }

  if (buildingId && DEFAULT_CAMERA_POINTS[buildingId]) {
    return DEFAULT_CAMERA_POINTS[buildingId];
  }

  if (buildingName && DEFAULT_CAMERA_POINTS[buildingName]) {
    return DEFAULT_CAMERA_POINTS[buildingName];
  }

  if (buildingName && BUILDING_POINTS[buildingName]) {
    return BUILDING_POINTS[buildingName];
  }

  return fallbackPoint(index);
}

export default function CampusMap({
  students,
  onSelectStudent,
  cameraLocations = {},
  cameras = [],
  isExpanded = true,
}) {
  const mapInstance = useRef(null);
  const mapShellRef = useRef(null);
  const idleTimerRef = useRef(null);
  const [mapReadyToken, setMapReadyToken] = useState(0);
  const [isMapActive, setIsMapActive] = useState(false);
  const [hasClickedToInteract, setHasClickedToInteract] = useState(false);

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
    setHasClickedToInteract(true);
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
  }, [cameras, isExpanded, students.length, cameraLocations]);

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

  return (
    <section className="panel map-wrap">
      <div className="map-head">
        <h3>Campus Map</h3>
        <div className="legend">
          <span><i className="dot online"></i>Online</span>
          <span><i className="dot alert"></i>Alert</span>
          <span><i className="dot offline"></i>Offline</span>
        </div>
      </div>
      <div
        ref={mapShellRef}
        className={`campus-map-shell${isMapActive ? " active" : ""}`}
        tabIndex={0}
        role="region"
        aria-label="Campus map. Click or press Enter to interact, and press Escape to exit map interaction mode."
        aria-describedby={hasClickedToInteract ? undefined : "map-interaction-hint"}
        onClick={activateMap}
        onKeyDown={handleMapKeyDown}
      >
        <MapContainer
          center={CAMPUS_CENTER}
          zoom={17}
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
          <TileLayer
            attribution='&copy; OpenStreetMap &copy; CARTO'
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          />
          {students.map((student, index) => {
            const position = studentPoint(student, index, cameraLocations);
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
                  <br />
                  {student.currentLocation?.buildingId || "unmapped-camera"}
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

        {!hasClickedToInteract ? (
          <div
            id="map-interaction-hint"
            className="map-interaction-hint"
            role="status"
            aria-live="polite"
          >
            Click to zoom • Scroll inside map to zoom in/out
          </div>
        ) : null}
      </div>
    </section>
  );
}
