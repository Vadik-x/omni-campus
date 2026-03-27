# Omni-Campus

Omni-Campus is a real-time campus student tracking dashboard that combines camera frames, AI re-identification, and fallback signal fusion to keep a live operational view of student movement.

## Architecture Overview

### System Layers

1. Input Layer:
   - Camera stream (RTSP or uploaded frame)
   - Simulated WiFi/RF fallback
   - Student profile database
2. Processing Layer:
   - Gemini frame analysis and student re-identification
   - Signal fusion loop running every 5 seconds
3. Fusion + Backend Layer:
   - Node.js + Express API
   - Socket.io real-time event broadcasting
   - MongoDB persistence with history trail
4. Output Layer:
   - React dashboard with map, list, feed, and detailed student panel

### Tech Stack

- Frontend: React 18, Vite, Leaflet, axios, socket.io-client
- Backend: Node.js, Express, Socket.io, Mongoose
- AI: Gemini 2.0 Flash via @google/generative-ai
- Database: MongoDB Atlas/local MongoDB
- Deploy: Vercel (frontend), Railway (backend), GitHub Actions CI/CD

## Repository Structure

- frontend: React dashboard
- backend: Express API, camera, Gemini, and fusion services
- .github/workflows/deploy.yml: CI/CD pipeline
- .env.example: required environment variables

## Environment Variables

Use .env.example as reference.

Required backend variables:

- MONGO_URI
- GEMINI_API_KEY
- CAMERA_URL
- CAMERA_ZONE
- PORT
- FRONTEND_URL

Required frontend variable:

- VITE_BACKEND_URL

## Local Setup

### 1. Backend

1. Open terminal in backend
2. Install dependencies:
   - npm install
3. Configure backend/.env (copy from .env.example)
4. Run backend:
   - npm start

### 2. Frontend

1. Open terminal in frontend
2. Install dependencies:
   - npm install
3. Configure frontend/.env with VITE_BACKEND_URL
4. Run frontend:
   - npm run dev

Frontend default URL: http://localhost:5173
Backend default URL: http://localhost:5000

If MongoDB is down, backend now starts in temporary mock mode automatically and serves seeded in-memory students so the dashboard remains usable.

## Camera Setup (IP Webcam Android App)

1. Install IP Webcam on Android (Play Store)
2. Connect phone and development machine to the same WiFi network
3. Open IP Webcam and start server
4. Copy the stream URL shown by the app (example: rtsp://PHONE_IP:554/h264_ulaw.sdp)
5. Set CAMERA_URL in backend/.env to that RTSP URL
6. Set CAMERA_ZONE to the physical camera area (example: Library - Block B)
7. Restart backend

If camera connection fails, backend automatically switches to mock mode.

## Demo Mode

Use simulated tracking when camera or Gemini is unavailable.

### Demo options

1. Use simulation endpoint:
   - POST /api/tracking/simulate
   - body: { "studentId": "OC1001", "buildingName": "Library - Block B" }
2. Use detection endpoint manually:
   - POST /api/tracking/detection
3. Observe live updates on dashboard:
   - student:update
   - detection:event

## API Highlights

- GET /api/students
- GET /api/students/:id
- POST /api/students
- PATCH /api/students/:id/location
- POST /api/tracking/detection
- POST /api/tracking/simulate
- POST /api/camera/frame
- GET /api/camera/status

## Deployment

### Frontend to Vercel

- Config file: frontend/vercel.json
- Uses VITE_BACKEND_URL as environment variable
- SPA routing handled with rewrite to index.html

### Backend to Railway

- Config files:
  - backend/Procfile
  - backend/railway.toml
- App starts with npm start and reads process.env.PORT

### CI/CD via GitHub Actions

Workflow: .github/workflows/deploy.yml

On push to main:

1. Install and test frontend
2. Install and test backend
3. Deploy frontend via Vercel CLI
4. Deploy backend via Railway CLI

Required GitHub Secrets:

- VERCEL_TOKEN
- VERCEL_ORG_ID
- VERCEL_PROJECT_ID
- RAILWAY_TOKEN
- RAILWAY_SERVICE

## Operations Notes

- Fusion loop runs every 5 seconds
- Students not seen for over 10 minutes are marked offline
- Blind spot fallback marks recent students as alert via WIFI-RF simulation

## YouTube Demo

Demo video placeholder:

- https://www.youtube.com/watch?v=YOUR_DEMO_VIDEO_ID
