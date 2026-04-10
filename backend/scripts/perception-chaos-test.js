require("dotenv").config();

const stabilityEngine = require("../services/stabilityEngine");

const FRAME_STEP_MS = Math.max(60, Number(process.env.CHAOS_FRAME_STEP_MS || 90));
const PERF_TARGET_MS = Math.max(1, Number(process.env.RECOGNITION_STABILITY_PERF_TARGET_MS || 5));

function hrNowMs() {
  if (typeof process.hrtime?.bigint === "function") {
    return Number(process.hrtime.bigint()) / 1e6;
  }

  return Date.now();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function average(values = []) {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdDev(values = []) {
  if (!Array.isArray(values) || values.length <= 1) {
    return 0;
  }

  const mean = average(values);
  const variance = average(values.map((value) => {
    const delta = value - mean;
    return delta * delta;
  }));

  return Math.sqrt(variance);
}

function percentile(values = [], ratio = 0.95) {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function makeBox(x, y, width = 96, height = 96) {
  return {
    x: Number(x),
    y: Number(y),
    width: Number(width),
    height: Number(height),
  };
}

function createRng(seed = 42) {
  let state = Number(seed) || 42;

  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const rng = createRng(20260410);

function jitterBox(base, radius = 8) {
  if (!base) {
    return null;
  }

  const offsetX = (rng() * 2 - 1) * radius;
  const offsetY = (rng() * 2 - 1) * radius;

  return makeBox(base.x + offsetX, base.y + offsetY, base.width, base.height);
}

function buildFrame({
  cameraId,
  trackId,
  detectedId,
  detectedName,
  confidence,
  box,
}) {
  return {
    cameraId,
    trackId,
    detectedId,
    detectedName,
    confidence,
    box,
  };
}

function runFrame(frame, state) {
  const callStartedAt = hrNowMs();

  const output = stabilityEngine.processFrame({
    cameraId: frame.cameraId,
    trackId: frame.trackId,
    timestamp: state.now,
    detectedId: frame.detectedId,
    detectedName: frame.detectedName,
    confidence: frame.confidence,
    pipelineLatencyMs: 55 + Math.round(rng() * 30),
    box: frame.box,
  });

  const callDurationMs = hrNowMs() - callStartedAt;
  state.now += FRAME_STEP_MS;

  return {
    output,
    callDurationMs,
  };
}

function createMetricsCollector() {
  return {
    totalFrames: 0,
    switchEvents: 0,
    falseSwitchCount: 0,
    lockDurationsMs: [],
    performanceSamplesMs: [],
    confidenceByTrack: new Map(),
    statusCounts: {},
  };
}

function recordFrameMetrics(metrics, frameResult) {
  const output = frameResult.output;
  metrics.totalFrames += 1;
  metrics.performanceSamplesMs.push(Number(frameResult.callDurationMs));

  const status = String(output?.status || "unknown");
  metrics.statusCounts[status] = (metrics.statusCounts[status] || 0) + 1;

  const events = Array.isArray(output?.events) ? output.events : [];
  events.forEach((event) => {
    const type = String(event?.type || "");
    if (type === "identity_switched") {
      metrics.switchEvents += 1;
    }

    if (type === "stability_locked") {
      const lockMs = Number(event?.details?.lockMs || 0);
      if (Number.isFinite(lockMs) && lockMs > 0) {
        metrics.lockDurationsMs.push(lockMs);
      }
    }
  });

  const confidence = Number(output?.confidence || 0);
  if (Number.isFinite(confidence)) {
    const key = `${String(output?.cameraId || "unknown-camera")}:${String(output?.trackId || "unknown-track")}`;
    if (!metrics.confidenceByTrack.has(key)) {
      metrics.confidenceByTrack.set(key, []);
    }

    metrics.confidenceByTrack.get(key).push(confidence);
  }
}

function collectScenarioFrames(frames, state, metrics) {
  const outputs = [];

  frames.forEach((frame) => {
    const frameResult = runFrame(frame, state);
    outputs.push(frameResult.output);
    recordFrameMetrics(metrics, frameResult);
  });

  return outputs;
}

function scenarioStableWithNoise(state, metrics) {
  const name = "Stable A then random noise";
  const cameraId = "chaos-cam-1";
  const trackId = "track-main";
  const baseBox = makeBox(120, 92, 94, 94);

  const frames = [];
  for (let i = 0; i < 6; i += 1) {
    frames.push(buildFrame({
      cameraId,
      trackId,
      detectedId: "A001",
      detectedName: "ALPHA",
      confidence: 0.92 - i * 0.01,
      box: jitterBox(baseBox, 5),
    }));
  }

  for (let i = 0; i < 9; i += 1) {
    const noiseType = i % 3;
    frames.push(buildFrame({
      cameraId,
      trackId,
      detectedId: noiseType === 0 ? "" : noiseType === 1 ? "NX" : "NY",
      detectedName: noiseType === 0 ? "" : "NOISE",
      confidence: noiseType === 0 ? 0 : 0.34 + rng() * 0.18,
      box: noiseType === 0 ? null : jitterBox(baseBox, 38),
    }));
  }

  const outputs = collectScenarioFrames(frames, state, metrics);
  const switchedToNoise = outputs.some((output) => {
    const stableId = String(output?.stableId || "");
    return stableId === "NX" || stableId === "NY";
  });

  const passed = !switchedToNoise;
  if (!passed) {
    metrics.falseSwitchCount += 1;
  }

  return {
    name,
    passed,
    details: passed
      ? "Maintained stable identity despite noise/partial matches"
      : "Unexpected switch to noisy identity",
  };
}

function scenarioOscillationNoFlicker(state, metrics) {
  const name = "A/B oscillation anti-flicker";
  const cameraId = "chaos-cam-2";
  const trackId = "track-main";
  const baseBox = makeBox(170, 104, 100, 100);

  const frames = [];
  for (let i = 0; i < 6; i += 1) {
    frames.push(buildFrame({
      cameraId,
      trackId,
      detectedId: "A001",
      detectedName: "ALPHA",
      confidence: 0.91,
      box: jitterBox(baseBox, 4),
    }));
  }

  const oscillation = ["B002", "A001", "B002", "A001", "B002", "A001", "B002", "A001"];
  oscillation.forEach((id) => {
    frames.push(buildFrame({
      cameraId,
      trackId,
      detectedId: id,
      detectedName: id === "A001" ? "ALPHA" : "BRAVO",
      confidence: id === "A001" ? 0.88 : 0.9,
      box: jitterBox(baseBox, 7),
    }));
  });

  const outputs = collectScenarioFrames(frames, state, metrics);
  const switchedToB = outputs.some((output) => String(output?.stableId || "") === "B002");

  const passed = !switchedToB;
  if (!passed) {
    metrics.falseSwitchCount += 1;
  }

  return {
    name,
    passed,
    details: passed
      ? "Oscillation remained stable without identity flicker"
      : "Identity flicker occurred during oscillation",
  };
}

function scenarioMultiTrackSwap(state, metrics) {
  const name = "Two tracks swap positions";
  const cameraId = "chaos-cam-3";

  const frames = [];
  for (let i = 0; i < 12; i += 1) {
    const leftX = 90 + i * 22;
    const rightX = 370 - i * 22;

    frames.push(buildFrame({
      cameraId,
      trackId: "left-track",
      detectedId: "A001",
      detectedName: "ALPHA",
      confidence: 0.9 - (i % 3) * 0.02,
      box: makeBox(leftX, 108, 92, 92),
    }));

    frames.push(buildFrame({
      cameraId,
      trackId: "right-track",
      detectedId: "B002",
      detectedName: "BRAVO",
      confidence: 0.91 - (i % 4) * 0.02,
      box: makeBox(rightX, 110, 92, 92),
    }));
  }

  const outputs = collectScenarioFrames(frames, state, metrics);
  const leftStable = outputs.filter((output) => output.trackId === "left-track").pop();
  const rightStable = outputs.filter((output) => output.trackId === "right-track").pop();

  const passed = String(leftStable?.stableId || "") === "A001"
    && String(rightStable?.stableId || "") === "B002";

  if (!passed) {
    metrics.falseSwitchCount += 1;
  }

  return {
    name,
    passed,
    details: passed
      ? "Track identity continuity held through positional crossing"
      : "Track identity continuity failed during swap",
  };
}

function scenarioDisappearReappear(state, metrics) {
  const name = "Disappear and reappear";
  const cameraId = "chaos-cam-4";
  const trackId = "track-main";
  const baseBox = makeBox(220, 118, 98, 98);

  const frames = [];
  for (let i = 0; i < 6; i += 1) {
    frames.push(buildFrame({
      cameraId,
      trackId,
      detectedId: "A001",
      detectedName: "ALPHA",
      confidence: 0.93,
      box: jitterBox(baseBox, 5),
    }));
  }

  for (let i = 0; i < 20; i += 1) {
    frames.push(buildFrame({
      cameraId,
      trackId,
      detectedId: "",
      detectedName: "",
      confidence: 0,
      box: null,
    }));
  }

  for (let i = 0; i < 7; i += 1) {
    frames.push(buildFrame({
      cameraId,
      trackId,
      detectedId: "A001",
      detectedName: "ALPHA",
      confidence: 0.9 - i * 0.01,
      box: jitterBox(baseBox, 6),
    }));
  }

  const outputs = collectScenarioFrames(frames, state, metrics);
  const sawLost = outputs.some((output) => String(output?.status || "") === "lost");
  const relocked = outputs.some((output) => String(output?.stableId || "") === "A001" && String(output?.status || "") === "confirmed");

  const passed = sawLost && relocked;
  if (!passed) {
    metrics.falseSwitchCount += 1;
  }

  return {
    name,
    passed,
    details: passed
      ? "System gracefully lost and re-locked identity"
      : "Loss/recovery behavior deviated from expectation",
  };
}

function confidenceStabilityScore(confidenceByTrack) {
  const perTrack = Array.from(confidenceByTrack.values()).map((samples) => {
    const finite = samples.filter((value) => Number.isFinite(value));
    if (finite.length <= 1) {
      return 1;
    }

    const sigma = stdDev(finite);
    return clamp(1 - sigma / 0.35, 0, 1);
  });

  if (perTrack.length === 0) {
    return 1;
  }

  return average(perTrack);
}

function run() {
  const state = {
    now: Date.now(),
  };
  const metrics = createMetricsCollector();

  const scenarios = [
    scenarioStableWithNoise,
    scenarioOscillationNoFlicker,
    scenarioMultiTrackSwap,
    scenarioDisappearReappear,
  ];

  const scenarioResults = scenarios.map((scenario) => scenario(state, metrics));

  const switchRate = metrics.switchEvents / Math.max(1, metrics.totalFrames);
  const avgLockDuration = average(metrics.lockDurationsMs);
  const confidenceStability = confidenceStabilityScore(metrics.confidenceByTrack);
  const avgProcessingMs = average(metrics.performanceSamplesMs);
  const p95ProcessingMs = percentile(metrics.performanceSamplesMs, 0.95);
  const perfPass = p95ProcessingMs <= PERF_TARGET_MS;

  const summary = {
    frameStepMs: FRAME_STEP_MS,
    totalFrames: metrics.totalFrames,
    switchRate: Number(switchRate.toFixed(4)),
    switchEvents: metrics.switchEvents,
    falseSwitchCount: metrics.falseSwitchCount,
    avgLockDurationMs: Number(avgLockDuration.toFixed(2)),
    confidenceStabilityScore: Number(confidenceStability.toFixed(4)),
    avgProcessingMs: Number(avgProcessingMs.toFixed(4)),
    p95ProcessingMs: Number(p95ProcessingMs.toFixed(4)),
    performanceTargetMs: PERF_TARGET_MS,
    performancePass: perfPass,
    statusCounts: metrics.statusCounts,
    scenarios: scenarioResults,
  };

  process.stdout.write("Perception chaos test summary\n");
  scenarioResults.forEach((scenario) => {
    process.stdout.write(
      `- [${scenario.passed ? "PASS" : "FAIL"}] ${scenario.name}: ${scenario.details}\n`
    );
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

  const failedScenarios = scenarioResults.filter((scenario) => !scenario.passed).length;
  if (failedScenarios > 0 || !perfPass) {
    process.exit(1);
  }
}

run();
