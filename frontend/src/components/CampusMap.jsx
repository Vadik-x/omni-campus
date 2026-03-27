import { CircleMarker, MapContainer, Popup, TileLayer } from "react-leaflet";

const CAMPUS_CENTER = [12.9716, 77.5946];
const BUILDING_POINTS = {
  "Library - Block B": [12.97195, 77.5941],
  "Main Gate": [12.9709, 77.5949],
  "Admin Block": [12.9714, 77.5953],
  "Engineering Block": [12.9722, 77.5948],
  Hostel: [12.9725, 77.5938],
  Auditorium: [12.9712, 77.5937],
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

function studentPoint(student, index) {
  const name = student.currentLocation?.buildingName;
  if (name && BUILDING_POINTS[name]) {
    return BUILDING_POINTS[name];
  }

  return fallbackPoint(index);
}

export default function CampusMap({ students, onSelectStudent }) {
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
      <MapContainer center={CAMPUS_CENTER} zoom={17} className="leaflet-map" zoomControl={false}>
        <TileLayer
          attribution='&copy; OpenStreetMap &copy; CARTO'
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        />
        {students.map((student, index) => {
          const position = studentPoint(student, index);
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
    </section>
  );
}
