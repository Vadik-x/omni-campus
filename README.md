# Omni-Campus

Prototype status: full ready.

Omni-Campus is a real-time campus monitoring dashboard for student presence and movement. It includes live camera feeds, face-based recognition, activity feed, movement trail, and an interactive campus map with draggable camera markers.

## What Is Included

- Real-time dashboard with student list, activity panel, and map view
- Face registration modal with multi-photo descriptor capture
- Duplicate-safe registration update flow by Student ID and name similarity
- Camera management (webcam, IP camera, DroidCam, custom URL)
- Socket-based live updates for detections and student lifecycle changes
- Persistent map center and camera positions in local storage
- Backend SQLite persistence with encrypted descriptor blobs
- Structured JSON runtime logs, in-memory alerts, and local health/stats endpoints
- Bulk cleanup support (`Clear All Data` in registry + backend `DELETE /api/students`)

## Tech Stack

- Frontend: React, Vite, React Router, React Leaflet, Socket.IO Client, Axios
- Backend: Node.js, Express, Socket.IO, dotenv
- Recognition: `@vladmandic/face-api` on frontend
- Storage: backend SQLite (`backend/data/omni-campus.db`) + browser localStorage cache

## Repository Structure

```text
.
|- frontend/                  # React app (dashboard, map, face registration UI)
|- backend/                   # Express + Socket.IO API and services
|  |- routes/                 # students, tracking, proxy camera routes
|  |- services/               # camera, fusion, student store
|  |- data/omni-campus.db     # persisted student/recognition records
|  |- data/audit-log.jsonl    # append-only security audit trail
|- .github/workflows/         # CI/CD workflow
|- .env.example               # environment variable template
```

## Fork And Setup (GitHub)

### 1. Fork The Repository

1. Open this repository on GitHub.
2. Click **Fork**.
3. Fork it to your own GitHub account.

### 2. Clone Your Fork

```bash
git clone https://github.com/<your-username>/<your-fork>.git
cd <your-fork>
```

Optional (recommended): keep upstream remote for syncing with original project.

```bash
git remote add upstream https://github.com/<original-owner>/<original-repo>.git
git remote -v
```

### 3. Install Prerequisites

- Node.js 20+
- npm 10+
- Modern browser (Chrome/Edge recommended)

Check versions:

```bash
node -v
npm -v
```

## Environment Setup

The root `.env.example` shows all variables you need.

### Backend (`backend/.env`)

Create `backend/.env` with:

```env
PORT=5000
FRONTEND_URL=http://localhost:5173
CAMERA_URL=0
CAMERA_ZONE=Library - Block B
```

Notes:

- `CAMERA_URL=0` keeps camera in local/mock-friendly mode.
- Set `CAMERA_URL` to an IP camera stream URL when using real camera input.

### Frontend (`frontend/.env`)

Create `frontend/.env` with:

```env
VITE_BACKEND_URL=http://localhost:5000
```

## Local Development

Open two terminals from project root.

### Terminal 1: Backend

```bash
cd backend
npm install
npm start
```

Backend default URL: `http://localhost:5000`

### Terminal 2: Frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend default URL: `http://localhost:5173`

## Build Validation

Frontend production build:

```bash
cd frontend
npm run build
```

Backend syntax check:

```bash
cd backend
node --check server.js
```

## Core API Endpoints

### Health

- `GET /health`
- `GET /api/health`
- `GET /api/alerts`
- `GET /api/stats`

### Students

- `GET /api/students`
- `GET /api/students/export`
- `GET /api/students/:id`
- `POST /api/students`
- `PATCH /api/students/:id`
- `PATCH /api/students/:id/location`
- `DELETE /api/students/:id`
- `DELETE /api/students` (clear all)

### Tracking

- `POST /api/tracking/detection`
- `POST /api/tracking/simulate`

### Recognition

- `GET /api/recognition/health`
- `GET /api/recognition/metrics`
- `GET /api/recognition/camera-profiles`
- `PUT /api/recognition/camera-profiles/:cameraId`
- `POST /api/recognition/enroll`
- `POST /api/recognition/reindex`
- `POST /api/recognition/match`
- `POST /api/recognition/match/direct`
- `GET /api/recognition/audit-logs`

### Camera Proxy

- `GET /api/proxy/stream?url=...`
- `GET /api/proxy/snapshot?url=...`
- `GET /api/proxy/test?url=...`

## Socket Events

### Client -> Server

- `camera:register`
- `camera:disconnect`
- `student:register`
- `face:detected`

### Server -> Client

- `student:update`
- `student:removed`
- `student:delete` (legacy compatibility)
- `students:cleared`
- `detection:event`
- `cameras:list`

## Typical Usage Flow

1. Open dashboard and add/connect camera(s).
2. Click **Register Face** and register student photos/descriptors.
3. If Student ID already exists, confirm update to merge descriptors.
4. Use map controls to set campus center and drag camera markers.
5. Monitor detections in activity feed and student detail panel.
6. Use **Clear All Data** in Face Registry danger zone when you need a full reset.

## Deployment (From Your Fork)

CI/CD workflow is in `.github/workflows/deploy.yml` and runs on push to `main`.

### Required GitHub Secrets

- `VERCEL_TOKEN`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`
- `RAILWAY_TOKEN`
- `RAILWAY_SERVICE`

### Frontend Deployment

- Platform: Vercel
- Reads `VITE_BACKEND_URL` from Vercel environment variables

### Backend Deployment

- Platform: Railway
- Reads runtime variables (`PORT`, `FRONTEND_URL`, `CAMERA_URL`, `CAMERA_ZONE`)

## Troubleshooting

- Port already in use:
  - Backend auto-falls forward to next port.
  - Update frontend `VITE_BACKEND_URL` if backend port changes.
- Camera not reachable:
  - Check device and machine are on same network.
  - Use `GET /api/proxy/test?url=...` to validate reachability.
- No detections visible:
  - Ensure students are registered with enough face descriptors.
  - Confirm camera feed is active and socket status is live.
- Map scroll feels locked:
  - Click inside map first to enable wheel zoom.

## Security And Hygiene

- Do not commit `.env` files.
- Keep API keys and deployment secrets only in local env or GitHub secrets.
- Remove test students using clear-all flow before demo or release.

### Phase 4 Security Controls

- RBAC is enabled for enrollment, delete, reindex, import, and tracking mutation routes.
- Signed detection payloads are enforced for `POST /api/recognition/match` and `POST /api/tracking/detection`.
- Socket `face:detected` payloads are signature-verified when `OMNI_REQUIRE_SIGNED_SOCKET_DETECTIONS=true`.
- Passive liveness checks are enforced for high-risk camera profiles.
- Descriptor vectors are encrypted at rest (AES-256-GCM) before being written to SQLite.
- Critical operations are written to an append-only audit file (`backend/data/audit-log.jsonl`).

### Phase 5 Production Hardening (Local Lightweight)

- Structured JSON logs for `api`, `camera`, and `recognition` services with INFO/WARN/ERROR levels.
- Runtime metrics buffer (`getRecentMetrics`) keeps the latest 100 detection/match latency records in memory.
- Local alert engine stores recent warnings in memory (high latency, low confidence, no detections, inactive cameras).
- `/api/health` reports uptime, memory usage, last detection timestamp, and average latency.
- `/api/alerts` returns recent in-memory alerts for quick debugging.
- `/api/stats` returns total detections, successful/failed matches, and average latency.
- Recognition pipeline has timeout + fallback behavior to avoid silent failures during long runtime.
- Audit service keeps the latest 50 audit events in memory for instant visibility.

Debug mode:
- Set `DEBUG=true` in backend env for richer structured log details.
- Keep `DEBUG=false` for concise production-style INFO/WARN/ERROR logging.

### Client Headers

- `X-Omni-Role`: `viewer` | `operator` | `admin`
- `X-Omni-User`: caller identifier for audit records
- `X-Omni-Api-Key`: optional API key (role resolution via `OMNI_RBAC_KEYS_JSON`)
- `X-Omni-Signature`, `X-Omni-Signature-Ts`: required for signed detection endpoints

---

If you fork this project and follow this guide, you should be able to run the full prototype locally and deploy it from your own GitHub repository.