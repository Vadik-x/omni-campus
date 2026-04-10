require("dotenv").config();

const security = require("../services/security");

const DEFAULT_BASES = [
  "http://localhost:5000",
  "http://localhost:5001",
  "http://localhost:5002",
  "http://localhost:5003",
  "http://localhost:5004",
  "http://localhost:5005",
];

const TEST_ROLE = process.env.SWITCH_TEST_ROLE || "admin";
const TEST_USER = process.env.SWITCH_TEST_USER || "switch-tester";
const TEST_API_KEY = process.env.SWITCH_TEST_API_KEY || process.env.OMNI_TEST_API_KEY || "";
const LOCK_WAIT_MS = Math.max(
  1100,
  Number(process.env.SWITCH_TEST_LOCK_WAIT_MS || process.env.RECOGNITION_STABILITY_LOCK_MS || 1500) + 200
);
const FRAME_GAP_MS = Math.max(25, Number(process.env.SWITCH_TEST_FRAME_GAP_MS || 80));

function makeDescriptor(baseValue) {
  return Array.from({ length: 128 }, (_, index) => {
    const centered = ((index % 11) - 5) * 0.004;
    const wave = Math.sin((index + 1) * (baseValue * 3 + 0.11)) * 0.01;
    return Number((baseValue + centered + wave).toFixed(6));
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildAuthHeaders() {
  const headers = {
    "content-type": "application/json",
    "x-omni-role": TEST_ROLE,
    "x-omni-user": TEST_USER,
  };

  if (TEST_API_KEY) {
    headers["x-omni-api-key"] = TEST_API_KEY;
  }

  return headers;
}

function fail(message, details) {
  const error = new Error(message);
  if (details !== undefined) {
    error.details = details;
  }

  throw error;
}

async function requestJson(baseUrl, routePath, options = {}) {
  const response = await fetch(`${baseUrl}${routePath}`, {
    ...options,
    headers: {
      ...buildAuthHeaders(),
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok) {
    fail(`HTTP ${response.status} on ${routePath}`, body);
  }

  return body;
}

async function detectBaseUrl() {
  const envBase = process.env.SWITCH_TEST_BASE_URL;
  const candidates = envBase ? [envBase] : DEFAULT_BASES;

  for (const baseUrl of candidates) {
    try {
      const health = await requestJson(baseUrl, "/health", { method: "GET" });
      if (health && health.status === "ok") {
        return baseUrl;
      }
    } catch (error) {
      // Continue scanning candidates.
    }
  }

  fail("No backend detected. Start backend (npm start) or set SWITCH_TEST_BASE_URL.");
}

function buildSignedHeaders(payload, scope = "recognition.match") {
  const signatureTs = String(Date.now());
  const signature = security.buildPayloadSignature({
    payload,
    signatureTs,
    scope,
  });

  return {
    "x-omni-signature": signature,
    "x-omni-signature-ts": signatureTs,
  };
}

async function post(baseUrl, routePath, payload, options = {}) {
  return requestJson(baseUrl, routePath, {
    method: "POST",
    body: JSON.stringify(payload),
    ...(options || {}),
  });
}

async function get(baseUrl, routePath, options = {}) {
  return requestJson(baseUrl, routePath, {
    method: "GET",
    ...(options || {}),
  });
}

async function del(baseUrl, routePath, options = {}) {
  return requestJson(baseUrl, routePath, {
    method: "DELETE",
    ...(options || {}),
  });
}

async function signedMatch(baseUrl, payload) {
  const signedHeaders = buildSignedHeaders(payload, "recognition.match");

  return requestJson(baseUrl, "/api/recognition/match", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: signedHeaders,
  });
}

async function sendFrameSequence({
  baseUrl,
  label,
  cameraId,
  cameraLabel,
  descriptor,
  frameCount,
  gapMs,
  trackHint,
}) {
  const output = [];

  for (let index = 0; index < frameCount; index += 1) {
    const payload = {
      descriptor,
      cameraId,
      cameraLabel,
      timestamp: new Date().toISOString(),
      topK: 3,
      trackHint,
    };

    const response = await signedMatch(baseUrl, payload);
    const frame = {
      label,
      frame: index + 1,
      status: response.status,
      stableId: response.stableId,
      confidence: response.confidence,
      decision: response?.pipeline?.decision,
      confirmThreshold: response?.pipeline?.stability?.confirmThreshold,
      uiPhase: response?.uiState?.phase,
      uiLabel: response?.uiState?.label,
      activeTrackCount: response?.pipeline?.stability?.activeTrackCount,
      trackId: response?.pipeline?.trackId || response?.trackId || trackHint || null,
      stableIdentities: Array.isArray(response?.stableIdentities)
        ? response.stableIdentities.map((item) => ({
            stableId: item?.stableId || null,
            trackId: item?.trackId || null,
            status: item?.status || null,
          }))
        : [],
    };

    output.push(frame);

    process.stdout.write(
      `[${label}] frame ${frame.frame}: status=${frame.status} phase=${frame.uiPhase || "none"} track=${frame.trackId || "null"} stableId=${frame.stableId || "null"} confidence=${Number(frame.confidence || 0).toFixed(3)} threshold=${Number(frame.confirmThreshold || 0).toFixed(3)} tracks=${Number(frame.activeTrackCount || 0)}\n`
    );

    if (index < frameCount - 1) {
      await sleep(gapMs);
    }
  }

  return output;
}

function hasPhase(frames, phase) {
  return (Array.isArray(frames) ? frames : []).some(
    (frame) => String(frame?.uiPhase || "") === String(phase || "")
  );
}

function hasAnyPhase(frames, phases = []) {
  return (Array.isArray(phases) ? phases : []).some((phase) => hasPhase(frames, phase));
}

function hasTopTwoStableIds(frames, stableIdA, stableIdB) {
  return (Array.isArray(frames) ? frames : []).some((frame) => {
    const ids = new Set(
      (Array.isArray(frame?.stableIdentities) ? frame.stableIdentities : [])
        .map((item) => String(item?.stableId || "").trim())
        .filter(Boolean)
    );

    return ids.has(String(stableIdA || "")) && ids.has(String(stableIdB || ""));
  });
}

async function run() {
  const baseUrl = await detectBaseUrl();
  const testStamp = Date.now();

  const studentAId = `SWA-${testStamp}`;
  const studentBId = `SWB-${testStamp}`;
  const descriptorA = makeDescriptor(0.06);
  const descriptorB = makeDescriptor(0.36);

  const cameraSwitchId = `cam-switch-${testStamp}`;
  const cameraOscillationId = `cam-oscillate-${testStamp}`;
  const cameraMultiTrackId = `cam-multitrack-${testStamp}`;

  process.stdout.write(`Using backend: ${baseUrl}\n`);
  process.stdout.write(`Student A: ${studentAId} | Student B: ${studentBId}\n`);

  try {
    await post(baseUrl, "/api/students", {
      studentId: studentAId,
      name: "ALPHA VECTOR NINE",
      program: "QA",
      year: 1,
      phone: "000",
      faceDescriptor: descriptorA,
    });

    await post(baseUrl, "/api/students", {
      studentId: studentBId,
      name: "ZULU ORBIT PRIME",
      program: "QA",
      year: 1,
      phone: "000",
      faceDescriptor: descriptorB,
    });

    const activeStudents = await get(baseUrl, "/api/students");
    const activeStudentIds = new Set(
      (Array.isArray(activeStudents) ? activeStudents : []).map((item) => String(item?.studentId || ""))
    );

    if (!activeStudentIds.has(studentAId) || !activeStudentIds.has(studentBId)) {
      fail("Test students were not both created; aborting switch validation", {
        activeStudentIds: Array.from(activeStudentIds),
        expected: [studentAId, studentBId],
      });
    }

    process.stdout.write("\nSequence 1: A A A A -> wait lock -> B B B B\n");

    const aConfirm = await sendFrameSequence({
      baseUrl,
      label: "confirm-A",
      cameraId: cameraSwitchId,
      cameraLabel: "Switch Test Camera",
      descriptor: descriptorA,
      frameCount: 4,
      gapMs: FRAME_GAP_MS,
    });

    await sleep(LOCK_WAIT_MS);

    const bSwitch = await sendFrameSequence({
      baseUrl,
      label: "switch-B",
      cameraId: cameraSwitchId,
      cameraLabel: "Switch Test Camera",
      descriptor: descriptorB,
      frameCount: 6,
      gapMs: FRAME_GAP_MS,
    });

    const aLocked = aConfirm[aConfirm.length - 1];
    if (!aLocked || aLocked.stableId !== studentAId || aLocked.status !== "confirmed") {
      fail("Precondition failed: sequence did not lock to A before switch window", {
        aConfirm,
      });
    }

    if (!hasAnyPhase(aConfirm, ["detecting", "looking"]) || !hasPhase(aConfirm, "locked")) {
      fail("UI contract missing detecting/locked phases during A confirmation", {
        aConfirm,
      });
    }

    const switchedFrame = bSwitch.find(
      (frame) => frame.status === "confirmed" && frame.stableId === studentBId
    );

    if (!switchedFrame) {
      fail("Expected identity switch to B did not occur", {
        aConfirm,
        bSwitch,
      });
    }

    if (!hasPhase(bSwitch, "switching")) {
      fail("UI contract missing switching phase during A->B transition", {
        bSwitch,
      });
    }

    process.stdout.write(`Switch evidence: confirmed ${studentBId} at frame ${switchedFrame.frame}\n`);

    process.stdout.write("\nSequence 2: A A A A -> wait lock -> B A B A (must NOT switch)\n");

    const aConfirmForOscillation = await sendFrameSequence({
      baseUrl,
      label: "confirm-A-osc",
      cameraId: cameraOscillationId,
      cameraLabel: "Oscillation Test Camera",
      descriptor: descriptorA,
      frameCount: 4,
      gapMs: FRAME_GAP_MS,
    });

    const aOscillationLock = aConfirmForOscillation[aConfirmForOscillation.length - 1];
    if (
      !aOscillationLock
      || aOscillationLock.stableId !== studentAId
      || aOscillationLock.status !== "confirmed"
    ) {
      fail("Precondition failed: oscillation camera did not lock to A", {
        aConfirmForOscillation,
      });
    }

    await sleep(LOCK_WAIT_MS);

    const oscillationFrames = [];
    const oscillationPlan = [descriptorB, descriptorA, descriptorB, descriptorA];

    for (let index = 0; index < oscillationPlan.length; index += 1) {
      const payload = {
        descriptor: oscillationPlan[index],
        cameraId: cameraOscillationId,
        cameraLabel: "Oscillation Test Camera",
        timestamp: new Date().toISOString(),
        topK: 3,
      };

      const response = await signedMatch(baseUrl, payload);
      const frame = {
        frame: index + 1,
        status: response.status,
        stableId: response.stableId,
        confidence: response.confidence,
        decision: response?.pipeline?.decision,
        uiPhase: response?.uiState?.phase,
        uiLabel: response?.uiState?.label,
      };

      oscillationFrames.push(frame);
      process.stdout.write(
        `[oscillate] frame ${frame.frame}: status=${frame.status} phase=${frame.uiPhase || "none"} stableId=${frame.stableId || "null"} confidence=${Number(frame.confidence || 0).toFixed(3)}\n`
      );

      if (index < oscillationPlan.length - 1) {
        await sleep(FRAME_GAP_MS);
      }
    }

    const improperSwitch = oscillationFrames.find(
      (frame) => frame.status === "confirmed" && frame.stableId === studentBId
    );

    if (improperSwitch) {
      fail("Oscillation sequence incorrectly switched identity", {
        aConfirmForOscillation,
        oscillationFrames,
      });
    }

    if (!hasPhase(oscillationFrames, "switching")) {
      fail("UI contract missing switching phase during oscillation challenge", {
        oscillationFrames,
      });
    }

    process.stdout.write("\nSequence 3: same camera, two tracks (top-2 stable identities)\n");

    const multiTrackFrames = [];
    const interleavedPlan = [
      { label: "multi-left", descriptor: descriptorA, trackHint: "left-track", tag: "A" },
      { label: "multi-right", descriptor: descriptorB, trackHint: "right-track", tag: "B" },
      { label: "multi-left", descriptor: descriptorA, trackHint: "left-track", tag: "A" },
      { label: "multi-right", descriptor: descriptorB, trackHint: "right-track", tag: "B" },
      { label: "multi-left", descriptor: descriptorA, trackHint: "left-track", tag: "A" },
      { label: "multi-right", descriptor: descriptorB, trackHint: "right-track", tag: "B" },
      { label: "multi-left", descriptor: descriptorA, trackHint: "left-track", tag: "A" },
      { label: "multi-right", descriptor: descriptorB, trackHint: "right-track", tag: "B" },
    ];

    for (let index = 0; index < interleavedPlan.length; index += 1) {
      const step = interleavedPlan[index];

      const sequenceFrames = await sendFrameSequence({
        baseUrl,
        label: step.label,
        cameraId: cameraMultiTrackId,
        cameraLabel: "Multi Track Test Camera",
        descriptor: step.descriptor,
        frameCount: 1,
        gapMs: FRAME_GAP_MS,
        trackHint: step.trackHint,
      });

      const latest = sequenceFrames[0];
      multiTrackFrames.push({
        ...latest,
        tag: step.tag,
      });

      if (index < interleavedPlan.length - 1) {
        await sleep(FRAME_GAP_MS);
      }
    }

    if (!hasTopTwoStableIds(multiTrackFrames, studentAId, studentBId)) {
      fail("Top-2 stable identities contract did not expose both tracks on one camera", {
        cameraMultiTrackId,
        multiTrackFrames,
      });
    }

    const noDualTrackCount = multiTrackFrames.every(
      (frame) => Number(frame?.activeTrackCount || 0) < 2
    );

    if (noDualTrackCount) {
      fail("Expected activeTrackCount to reach at least 2 for multitrack scenario", {
        cameraMultiTrackId,
        multiTrackFrames,
      });
    }

    process.stdout.write("\nPASS: switch and anti-switch behavior validated.\n");
    process.stdout.write(
      `${JSON.stringify(
        {
          baseUrl,
          switchObserved: true,
          switchTarget: studentBId,
          antiSwitchObserved: true,
          uiContractObserved: true,
          multiTrackTop2Observed: true,
          cameraSwitchId,
          cameraOscillationId,
          cameraMultiTrackId,
          lockWaitMs: LOCK_WAIT_MS,
          frameGapMs: FRAME_GAP_MS,
        },
        null,
        2
      )}\n`
    );
  } finally {
    // Best-effort cleanup; this must not hide sequence results.
    await Promise.allSettled([
      del(baseUrl, `/api/students/${encodeURIComponent(studentAId)}`),
      del(baseUrl, `/api/students/${encodeURIComponent(studentBId)}`),
    ]);
  }
}

run().catch((error) => {
  process.stderr.write(`FAIL: ${error.message}\n`);
  if (error.details !== undefined) {
    process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
  }
  process.exit(1);
});
