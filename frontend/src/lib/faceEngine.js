import * as faceapi from "@vladmandic/face-api";

const MODEL_URI = "/models";
const STORAGE_KEY = "omni_face_registry";

const MATCH_THRESHOLD = 0.55;
const DEFAULT_UPSCALE_FACTOR = 2;
const SSD_MIN_CONFIDENCE = 0.3;
const SSD_MAX_RESULTS = 10;
const TINY_FALLBACK_INPUT_SIZE = 416;
const TINY_FALLBACK_SCORE_THRESHOLD = 0.2;

const TRACK_CONFIRMATION_FRAMES = 2;
const TRACK_IOU_THRESHOLD = 0.5;
const TRACK_MAX_AGE_MS = 800;
const TRACK_PERSIST_NO_FACE_MS = 800;

const REGISTRATION_CAPTURE_DELAY_MS = 500;
const DEFAULT_REGISTRATION_STEPS = [
  "Step 1: Stand 0.5m from camera - CAPTURE",
  "Step 2: Step back 1m - CAPTURE",
  "Step 3: Step back 2m - CAPTURE",
  "Step 4: Turn head slightly left - CAPTURE",
  "Step 5: Turn head slightly right - CAPTURE",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeName(value, fallback = "Unknown") {
  const next = String(value || "").trim();
  return next || fallback;
}

function normalizePersonId(value) {
  return String(value || "").trim();
}

function asFloat32Array(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Float32Array) {
    return value;
  }

  if (Array.isArray(value)) {
    return new Float32Array(value);
  }

  if (typeof value === "object") {
    const descriptor = new Float32Array(Object.values(value));
    return descriptor.length > 0 ? descriptor : null;
  }

  return null;
}

function toDescriptorArray(value) {
  const descriptor = asFloat32Array(value);
  if (!descriptor) {
    return null;
  }

  return Array.from(descriptor);
}

function getElementDimensions(element) {
  const width =
    Number(element?.videoWidth || element?.naturalWidth || element?.width || 0) || 0;
  const height =
    Number(element?.videoHeight || element?.naturalHeight || element?.height || 0) || 0;

  return {
    width,
    height,
  };
}

function buildTrackId(counter) {
  return `trk-${counter.toString(36)}-${Date.now().toString(36)}`;
}

function intersectionOverUnion(boxA, boxB) {
  if (!boxA || !boxB) {
    return 0;
  }

  const ax1 = Number(boxA.x || 0);
  const ay1 = Number(boxA.y || 0);
  const ax2 = ax1 + Number(boxA.width || 0);
  const ay2 = ay1 + Number(boxA.height || 0);

  const bx1 = Number(boxB.x || 0);
  const by1 = Number(boxB.y || 0);
  const bx2 = bx1 + Number(boxB.width || 0);
  const by2 = by1 + Number(boxB.height || 0);

  const interX1 = Math.max(ax1, bx1);
  const interY1 = Math.max(ay1, by1);
  const interX2 = Math.min(ax2, bx2);
  const interY2 = Math.min(ay2, by2);

  const interW = Math.max(0, interX2 - interX1);
  const interH = Math.max(0, interY2 - interY1);
  const interArea = interW * interH;

  const areaA = Math.max(0, Number(boxA.width || 0)) * Math.max(0, Number(boxA.height || 0));
  const areaB = Math.max(0, Number(boxB.width || 0)) * Math.max(0, Number(boxB.height || 0));
  const union = areaA + areaB - interArea;

  if (union <= 0) {
    return 0;
  }

  return interArea / union;
}

function resolveUiPresentation(displayState, name, confidence) {
  if (displayState === "face") {
    return {
      displayLabel: `${name} ${Math.round(clamp(confidence, 0, 1) * 100)}%`,
      boxColor: "#00ff88",
      boxDashed: false,
      statusType: "identified",
    };
  }

  if (displayState === "temporal") {
    return {
      displayLabel: `${name} ~`,
      boxColor: "#00ff88",
      boxDashed: true,
      statusType: "temporal",
    };
  }

  return {
    displayLabel: "Unknown",
    boxColor: "#ffd447",
    boxDashed: false,
    statusType: "unknown",
  };
}

class FaceEngine {
  constructor() {
    this.faceDatabase = new Map();
    this.modelsLoaded = false;
    this.loadingPromise = null;
    this.rehydrated = false;
    this.threshold = MATCH_THRESHOLD;

    this.trackCounter = 0;
    this.trackingState = new Map();
  }

  persistToStorage() {
    if (typeof window === "undefined") {
      return;
    }

    try {
      const payload = Array.from(this.faceDatabase.entries()).map(([personId, person]) => {
        const descriptors = (Array.isArray(person?.descriptors) ? person.descriptors : [])
          .map((storedArray) => {
            if (storedArray instanceof Float32Array) {
              return Array.from(storedArray);
            }

            const descriptor = new Float32Array(Object.values(storedArray || {}));
            return Array.from(descriptor);
          })
          .filter((descriptor) => descriptor.length > 0);

        return {
          personId,
          name: normalizeName(person?.name),
          descriptors,
        };
      });

      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (error) {
      console.warn("Failed to persist face descriptors", error);
    }
  }

  async loadModels() {
    if (this.modelsLoaded) {
      return true;
    }

    if (this.loadingPromise) {
      return this.loadingPromise;
    }

    this.loadingPromise = (async () => {
      if (faceapi.tf?.setBackend) {
        try {
          await faceapi.tf.setBackend("webgl");
        } catch (error) {
          await faceapi.tf.setBackend("cpu");
        }

        if (faceapi.tf?.ready) {
          await faceapi.tf.ready();
        }
      }

      await faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URI);
      console.log("ssdMobilenetv1 model loaded");

      await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URI);
      console.log("faceLandmark68Net model loaded");

      await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URI);
      console.log("faceRecognitionNet model loaded");

      await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URI);
      console.log("tinyFaceDetector model loaded");

      this.modelsLoaded = true;
      await this.rehydrateFromStorage();
      return true;
    })();

    return this.loadingPromise;
  }

  async rehydrateFromStorage() {
    if (this.rehydrated) {
      return this.getPersonCount();
    }

    if (typeof window === "undefined") {
      this.rehydrated = true;
      return this.getPersonCount();
    }

    let hydratedCount = 0;

    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        this.rehydrated = true;
        console.log("Rehydrated 0 people from localStorage");
        return 0;
      }

      const parsed = JSON.parse(raw);
      const people = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.people)
          ? parsed.people
          : [];

      people.forEach((person) => {
        const personId = normalizePersonId(person?.personId || person?.studentId);
        if (!personId) {
          return;
        }

        const name = normalizeName(person?.name || person?.fullName);
        const sourceDescriptors = Array.isArray(person?.descriptors)
          ? person.descriptors
          : Array.isArray(person?.faceDescriptors)
            ? person.faceDescriptors
            : [];

        const descriptors = sourceDescriptors
          .map((storedArray) => {
            const descriptor = asFloat32Array(storedArray);
            return descriptor && descriptor.length > 0 ? descriptor : null;
          })
          .filter(Boolean);

        if (descriptors.length === 0) {
          return;
        }

        this.faceDatabase.set(personId, {
          name,
          descriptors,
        });
        hydratedCount += 1;
      });
    } catch (error) {
      hydratedCount = 0;
    }

    this.rehydrated = true;
    console.log(`Rehydrated ${hydratedCount} people from localStorage`);
    return hydratedCount;
  }

  hasPerson(personId) {
    return this.faceDatabase.has(normalizePersonId(personId));
  }

  getPersonCount() {
    return this.faceDatabase.size;
  }

  getAllPeople() {
    return Array.from(this.faceDatabase.entries()).map(([personId, person]) => ({
      personId,
      name: person.name,
      descriptorCount: (person.descriptors || []).length,
    }));
  }

  listPeople() {
    return this.getAllPeople();
  }

  clearPerson(personId) {
    const key = normalizePersonId(personId);
    const removed = this.faceDatabase.delete(key);
    if (removed) {
      this.persistToStorage();
    }
    return removed;
  }

  removePerson(personId) {
    return this.clearPerson(personId);
  }

  clearAllPeople() {
    this.faceDatabase.clear();
    this.trackingState.clear();
    this.persistToStorage();
  }

  setPersonDescriptors(personId, name, descriptorArrays = []) {
    const key = normalizePersonId(personId);
    if (!key) {
      return null;
    }

    const descriptors = descriptorArrays
      .map((entry) => asFloat32Array(entry))
      .filter((entry) => entry && entry.length > 0);

    this.faceDatabase.set(key, {
      name: normalizeName(name),
      descriptors,
    });
    this.persistToStorage();

    return {
      personId: key,
      name: normalizeName(name),
      descriptorCount: descriptors.length,
    };
  }

  getPersonDescriptors(personId) {
    const key = normalizePersonId(personId);
    const person = this.faceDatabase.get(key);
    if (!person) {
      return [];
    }

    return (person.descriptors || [])
      .map((entry) => toDescriptorArray(entry))
      .filter(Boolean);
  }

  async detectSingleFaceWithFallback(imageElement, options = {}) {
    const ssdMinConfidence = Number.isFinite(Number(options.minConfidence))
      ? Number(options.minConfidence)
      : SSD_MIN_CONFIDENCE;

    let detection = await faceapi
      .detectSingleFace(
        imageElement,
        new faceapi.SsdMobilenetv1Options({
          minConfidence: ssdMinConfidence,
          maxResults: 1,
        })
      )
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (detection) {
      return {
        detection,
        detector: "ssd",
      };
    }

    const tinyInputSize = Number(options.inputSize) > 0
      ? Number(options.inputSize)
      : TINY_FALLBACK_INPUT_SIZE;
    const tinyScoreThreshold = Number.isFinite(Number(options.scoreThreshold))
      ? Number(options.scoreThreshold)
      : TINY_FALLBACK_SCORE_THRESHOLD;

    detection = await faceapi
      .detectSingleFace(
        imageElement,
        new faceapi.TinyFaceDetectorOptions({
          inputSize: tinyInputSize,
          scoreThreshold: tinyScoreThreshold,
        })
      )
      .withFaceLandmarks()
      .withFaceDescriptor();

    return {
      detection,
      detector: detection ? "tiny" : "none",
    };
  }

  async extractFaceDescriptor(imageElement, options = {}) {
    await this.loadModels();

    if (!imageElement) {
      return null;
    }

    const { detection, detector } = await this.detectSingleFaceWithFallback(imageElement, options);

    const descriptor = toDescriptorArray(detection?.descriptor);
    if (!descriptor) {
      return null;
    }

    return {
      descriptor,
      score: Number(detection?.detection?.score || 0),
      box: detection?.detection?.box || null,
      detector,
    };
  }

  async registerPerson(personId, name, captureSource, options = {}) {
    const key = normalizePersonId(personId);
    if (!key) {
      return null;
    }

    const cleanName = normalizeName(name);
    await this.loadModels();

    const captureSteps = Array.isArray(options.captureSteps) && options.captureSteps.length > 0
      ? options.captureSteps
      : DEFAULT_REGISTRATION_STEPS;
    const delayMs = Number(options.captureDelayMs) > 0
      ? Number(options.captureDelayMs)
      : REGISTRATION_CAPTURE_DELAY_MS;

    const getCapture = typeof captureSource === "function"
      ? captureSource
      : async () => captureSource;

    const capturedDescriptors = [];

    for (let index = 0; index < captureSteps.length; index += 1) {
      const instruction = String(captureSteps[index] || "Capture");

      if (typeof options.onInstruction === "function") {
        options.onInstruction({
          step: index + 1,
          total: captureSteps.length,
          instruction,
        });
      } else {
        console.log(instruction);
      }

      const element = await getCapture({
        stepIndex: index,
        step: index + 1,
        total: captureSteps.length,
        instruction,
      });

      if (!element) {
        if (index < captureSteps.length - 1) {
          await sleep(delayMs);
        }
        continue;
      }

      const { detection } = await this.detectSingleFaceWithFallback(element, {
        minConfidence: SSD_MIN_CONFIDENCE,
        inputSize: TINY_FALLBACK_INPUT_SIZE,
        scoreThreshold: TINY_FALLBACK_SCORE_THRESHOLD,
      });

      const descriptor = asFloat32Array(detection?.descriptor);
      if (descriptor && descriptor.length > 0) {
        capturedDescriptors.push(descriptor);
      }

      if (index < captureSteps.length - 1) {
        await sleep(delayMs);
      }
    }

    if (capturedDescriptors.length === 0) {
      throw new Error("No face detected in image - please try a clearer photo");
    }

    this.faceDatabase.set(key, {
      name: cleanName,
      // Keep all captures for better distance/angle invariance.
      descriptors: capturedDescriptors,
    });
    this.persistToStorage();

    return {
      personId: key,
      name: cleanName,
      descriptorCount: capturedDescriptors.length,
      descriptor: Array.from(capturedDescriptors[0] || []),
      descriptors: capturedDescriptors.map((item) => Array.from(item)),
      captureSteps,
    };
  }

  identifyFace(queryDescriptorInput) {
    const query = asFloat32Array(queryDescriptorInput);
    if (!(query instanceof Float32Array) || query.length === 0) {
      return null;
    }

    let globalBestDistance = Number.POSITIVE_INFINITY;
    let bestMatch = null;

    for (const [personId, person] of this.faceDatabase.entries()) {
      const knownDescriptors = Array.isArray(person.descriptors) ? person.descriptors : [];
      let personBestDistance = Number.POSITIVE_INFINITY;

      for (const storedDescriptorInput of knownDescriptors) {
        const storedDescriptor = asFloat32Array(storedDescriptorInput);
        if (!(storedDescriptor instanceof Float32Array) || storedDescriptor.length === 0) {
          continue;
        }

        const distance = faceapi.euclideanDistance(query, storedDescriptor);
        if (distance < personBestDistance) {
          personBestDistance = distance;
        }
      }

      if (personBestDistance < globalBestDistance) {
        globalBestDistance = personBestDistance;
        bestMatch = {
          personId,
          name: person.name,
        };
      }
    }

    if (!bestMatch) {
      return null;
    }

    if (globalBestDistance < this.threshold) {
      return {
        personId: bestMatch.personId,
        name: bestMatch.name,
        confidence: Number(clamp(1 - globalBestDistance, 0, 1).toFixed(3)),
        distance: Number(globalBestDistance.toFixed(4)),
      };
    }

    return null;
  }

  prepareDetectionSource(videoElement, options = {}) {
    const requestedUpscale = Number(options.upscaleFactor);
    const upscaleFactor = requestedUpscale > 1 ? requestedUpscale : DEFAULT_UPSCALE_FACTOR;

    if (typeof document === "undefined" || upscaleFactor <= 1) {
      return {
        targetElement: videoElement,
        scaleBack: 1,
      };
    }

    const { width, height } = getElementDimensions(videoElement);
    const safeWidth = width || 640;
    const safeHeight = height || 480;

    const upCanvas = document.createElement("canvas");
    upCanvas.width = Math.max(1, Math.floor(safeWidth * upscaleFactor));
    upCanvas.height = Math.max(1, Math.floor(safeHeight * upscaleFactor));

    const context = upCanvas.getContext("2d");
    if (context) {
      context.drawImage(videoElement, 0, 0, upCanvas.width, upCanvas.height);
    }

    return {
      targetElement: upCanvas,
      scaleBack: 1 / upscaleFactor,
    };
  }

  async detectFacesWithFallback(sourceElement) {
    const primaryDetections = await faceapi
      .detectAllFaces(
        sourceElement,
        new faceapi.SsdMobilenetv1Options({
          minConfidence: SSD_MIN_CONFIDENCE,
          maxResults: SSD_MAX_RESULTS,
        })
      )
      .withFaceLandmarks()
      .withFaceDescriptors();

    if (primaryDetections.length > 0) {
      return {
        detections: primaryDetections,
        detector: "ssd",
      };
    }

    const fallbackDetections = await faceapi
      .detectAllFaces(
        sourceElement,
        new faceapi.TinyFaceDetectorOptions({
          inputSize: TINY_FALLBACK_INPUT_SIZE,
          scoreThreshold: TINY_FALLBACK_SCORE_THRESHOLD,
        })
      )
      .withFaceLandmarks()
      .withFaceDescriptors();

    return {
      detections: fallbackDetections,
      detector: fallbackDetections.length > 0 ? "tiny" : "none",
    };
  }

  selectTrackForBox(box, tracks, usedTrackIds) {
    let bestTrack = null;
    let bestIou = 0;

    tracks.forEach((track) => {
      if (!track?.lastBox) {
        return;
      }
      if (usedTrackIds.has(track.trackId)) {
        return;
      }

      const iou = intersectionOverUnion(box, track.lastBox);
      if (iou > bestIou) {
        bestIou = iou;
        bestTrack = track;
      }
    });

    if (bestIou > TRACK_IOU_THRESHOLD) {
      return bestTrack;
    }

    return null;
  }

  buildDetectionOutput({
    box,
    descriptor,
    personId,
    name,
    confidence,
    displayState,
    trackId,
    isConfirmed,
    emitConfidence,
    detector,
    distance,
  }) {
    const ui = resolveUiPresentation(displayState, name, confidence);

    const normalizedConfidence = Number(clamp(confidence || 0, 0, 1).toFixed(3));
    const normalizedEmitConfidence = Number(clamp(emitConfidence || 0, 0, 1).toFixed(3));
    const shouldEmit =
      Boolean(personId)
      && Boolean(isConfirmed)
      && displayState === "face"
      && normalizedEmitConfidence > 0.45;

    return {
      box,
      descriptor: descriptor || [],
      match: personId
        ? {
            personId,
            name,
            confidence: normalizedConfidence,
            distance: Number.isFinite(Number(distance)) ? Number(Number(distance).toFixed(4)) : null,
            mode: displayState,
          }
        : null,
      trackId,
      detector,
      displayState,
      statusType: ui.statusType,
      displayLabel: ui.displayLabel,
      boxColor: ui.boxColor,
      boxDashed: ui.boxDashed,
      isConfirmed,
      shouldEmit,
      emitConfidence: normalizedEmitConfidence,
    };
  }

  async processVideoFrame(videoElement, options = {}) {
    await this.loadModels();

    if (!videoElement) {
      return [];
    }

    const now = Date.now();
    const { targetElement, scaleBack } = this.prepareDetectionSource(videoElement, options);

    const { detections, detector } = await this.detectFacesWithFallback(targetElement);

    const activeTracks = Array.from(this.trackingState.values()).filter(
      (track) => now - Number(track?.lastSeenAt || 0) <= TRACK_MAX_AGE_MS
    );

    const nextTrackingState = new Map();
    const usedTrackIds = new Set();
    const outputs = [];

    detections.forEach((detection) => {
      const rawBox = detection?.detection?.box || {};
      const scaledBox = {
        x: Number(rawBox.x || 0) * scaleBack,
        y: Number(rawBox.y || 0) * scaleBack,
        width: Number(rawBox.width || 0) * scaleBack,
        height: Number(rawBox.height || 0) * scaleBack,
      };

      const previousTrack = this.selectTrackForBox(scaledBox, activeTracks, usedTrackIds);
      const trackId = previousTrack?.trackId || buildTrackId(++this.trackCounter);
      usedTrackIds.add(trackId);

      const descriptorFloat = asFloat32Array(detection?.descriptor);
      const descriptorArray = toDescriptorArray(descriptorFloat) || [];

      const faceMatch = this.identifyFace(descriptorFloat);

      let personId = null;
      let name = "Unknown";
      let confidence = 0;
      let displayState = "unknown";
      let emitConfidence = 0;
      let distance = null;
      let consecutiveFrames = 0;
      let isConfirmed = false;

      if (faceMatch) {
        personId = faceMatch.personId;
        name = faceMatch.name;
        confidence = Number(faceMatch.confidence || 0);
        distance = faceMatch.distance;

        const isSamePersonAsPrevious =
          Boolean(previousTrack?.personId)
          && previousTrack.personId === faceMatch.personId
          && previousTrack.lastMatchType === "face";
        consecutiveFrames = isSamePersonAsPrevious
          ? Number(previousTrack?.consecutiveFrames || 0) + 1
          : 1;
        isConfirmed = consecutiveFrames >= TRACK_CONFIRMATION_FRAMES;

        if (isConfirmed) {
          displayState = "face";
          emitConfidence = confidence;
        }
      } else if (previousTrack?.personId && previousTrack?.isConfirmed) {
        const ageMs = now - Number(previousTrack.lastSeenAt || 0);
        if (ageMs <= TRACK_PERSIST_NO_FACE_MS) {
          personId = previousTrack.personId;
          name = previousTrack.name;
          confidence = clamp(Number(previousTrack.confidence || 0.55) * 0.96, 0.45, 0.99);
          displayState = "temporal";
          consecutiveFrames = Number(previousTrack.consecutiveFrames || TRACK_CONFIRMATION_FRAMES);
          isConfirmed = true;
        }
      }

      const updatedTrack = {
        trackId,
        personId,
        name,
        lastFaceDescriptor: descriptorArray,
        lastSeenAt:
          faceMatch || displayState === "unknown"
            ? now
            : Number(previousTrack?.lastSeenAt || now),
        confidence: Number(clamp(confidence, 0, 1).toFixed(3)),
        consecutiveFrames,
        lastBox: scaledBox,
        isConfirmed,
        lastMatchType: faceMatch ? "face" : displayState,
      };

      nextTrackingState.set(trackId, updatedTrack);

      if (faceMatch && !isConfirmed) {
        return;
      }

      outputs.push(
        this.buildDetectionOutput({
          box: scaledBox,
          descriptor: descriptorArray,
          personId,
          name,
          confidence,
          displayState,
          trackId,
          isConfirmed,
          emitConfidence,
          detector,
          distance,
        })
      );
    });

    activeTracks.forEach((track) => {
      if (usedTrackIds.has(track.trackId)) {
        return;
      }

      const ageMs = now - Number(track.lastSeenAt || 0);
      if (ageMs > TRACK_MAX_AGE_MS) {
        return;
      }

      nextTrackingState.set(track.trackId, track);

      if (
        track.personId
        && track.isConfirmed
        && track.lastBox
        && ageMs <= TRACK_PERSIST_NO_FACE_MS
      ) {
        outputs.push(
          this.buildDetectionOutput({
            box: track.lastBox,
            descriptor: track.lastFaceDescriptor || [],
            personId: track.personId,
            name: track.name,
            confidence: track.confidence,
            displayState: "temporal",
            trackId: track.trackId,
            isConfirmed: true,
            emitConfidence: 0,
            detector: "temporal",
            distance: null,
          })
        );
      }
    });

    this.trackingState = new Map(
      Array.from(nextTrackingState.values())
        .filter((track) => now - Number(track.lastSeenAt || 0) <= TRACK_MAX_AGE_MS)
        .map((track) => [track.trackId, track])
    );

    return outputs;
  }
}

export const faceEngine = new FaceEngine();

export function getFaceEngineStatus() {
  return {
    modelsLoaded: faceEngine.modelsLoaded,
    peopleRegistered: faceEngine.getPersonCount(),
    activeTracks: faceEngine.trackingState.size,
    names: faceEngine.getAllPeople().map((person) => person.name),
  };
}

if (typeof window !== "undefined") {
  window.faceStatus = () => getFaceEngineStatus();
  window.faceDebug = () => {
    console.log("People in DB:", faceEngine.faceDatabase.size);
    faceEngine.faceDatabase.forEach((value, key) => {
      console.log(
        key,
        value.name,
        "descriptors:",
        value.descriptors.length,
        "first desc type:",
        value.descriptors[0]?.constructor?.name
      );
    });

    console.log("Active tracks:", faceEngine.trackingState.size);
    faceEngine.trackingState.forEach((track) => {
      console.log(track.trackId, track.name, track.personId, track.consecutiveFrames);
    });
  };
}
