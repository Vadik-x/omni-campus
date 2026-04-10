const DEFAULT_DISTANCE_THRESHOLD = Number(process.env.RECOGNITION_DISTANCE_THRESHOLD || 0.45);
const MIN_THRESHOLD = Number(process.env.RECOGNITION_MIN_THRESHOLD || 0.35);
const MAX_THRESHOLD = Number(process.env.RECOGNITION_MAX_THRESHOLD || 0.65);
const DEFAULT_LIVENESS_MIN_SCORE = Number(process.env.RECOGNITION_LIVENESS_MIN_SCORE || 0.45);

const keywordProfiles = [
  {
    profile: "outdoor-relaxed",
    keywords: ["gate", "entrance", "outdoor", "parking", "road"],
    offset: 0.03,
    highRisk: true,
  },
  {
    profile: "indoor-strict",
    keywords: ["lab", "class", "office", "library", "hall"],
    offset: -0.015,
    highRisk: false,
  },
];

const cameraProfiles = new Map();
const highRiskCameraIds = new Set();

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function asThreshold(value, fallback = DEFAULT_DISTANCE_THRESHOLD) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return clamp(Number(fallback), MIN_THRESHOLD, MAX_THRESHOLD);
  }

  return clamp(numeric, MIN_THRESHOLD, MAX_THRESHOLD);
}

function asLivenessMinScore(value, fallback = DEFAULT_LIVENESS_MIN_SCORE) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return clamp(Number(fallback), 0.05, 0.95);
  }

  return clamp(numeric, 0.05, 0.95);
}

function asBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(normalized)) {
      return true;
    }

    if (["0", "false", "no", "n", "off"].includes(normalized)) {
      return false;
    }
  }

  return fallback;
}

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function parseHighRiskCameraIds() {
  const raw = String(process.env.RECOGNITION_HIGH_RISK_CAMERAS || "").trim();
  if (!raw) {
    return;
  }

  raw
    .split(",")
    .map((item) => normalizeKey(item))
    .filter(Boolean)
    .forEach((cameraId) => {
      highRiskCameraIds.add(cameraId);
    });
}

parseHighRiskCameraIds();

function parseEnvProfiles() {
  try {
    const raw = process.env.RECOGNITION_CAMERA_PROFILES_JSON;
    if (!raw) {
      return;
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }

    Object.entries(parsed).forEach(([cameraId, config]) => {
      const key = normalizeKey(cameraId);
      if (!key) {
        return;
      }

      if (typeof config === "number") {
        cameraProfiles.set(key, {
          thresholdDistance: asThreshold(config),
          highRisk: highRiskCameraIds.has(key),
          livenessMinScore: asLivenessMinScore(DEFAULT_LIVENESS_MIN_SCORE),
          notes: "env-profile",
          source: "env",
        });
        return;
      }

      if (config && typeof config === "object") {
        cameraProfiles.set(key, {
          thresholdDistance: asThreshold(config.thresholdDistance),
          highRisk:
            asBoolean(config.highRisk, false) || highRiskCameraIds.has(key),
          livenessMinScore: asLivenessMinScore(config.livenessMinScore),
          notes: String(config.notes || "env-profile"),
          source: "env",
        });
      }
    });
  } catch (error) {
    // Ignore env parsing errors and use defaults.
  }
}

parseEnvProfiles();

function resolveKeywordProfile(cameraLabel = "") {
  const normalizedLabel = normalizeKey(cameraLabel);
  if (!normalizedLabel) {
    return null;
  }

  const matched = keywordProfiles.find((entry) =>
    entry.keywords.some((keyword) => normalizedLabel.includes(keyword))
  );

  if (!matched) {
    return null;
  }

  return {
    profile: matched.profile,
    thresholdDistance: asThreshold(DEFAULT_DISTANCE_THRESHOLD + matched.offset),
    highRisk: Boolean(matched.highRisk),
    livenessMinScore: asLivenessMinScore(DEFAULT_LIVENESS_MIN_SCORE),
    source: "keyword",
  };
}

function resolveThreshold({ cameraId, cameraLabel, requestedThreshold } = {}) {
  const idKey = normalizeKey(cameraId);
  const labelKey = normalizeKey(cameraLabel);

  const requested = Number(requestedThreshold);
  if (Number.isFinite(requested)) {
    return {
      profile: "request-override",
      source: "request",
      thresholdDistance: asThreshold(requested),
      highRisk: highRiskCameraIds.has(idKey) || highRiskCameraIds.has(labelKey),
      livenessMinScore: asLivenessMinScore(DEFAULT_LIVENESS_MIN_SCORE),
    };
  }

  const directProfile = cameraProfiles.get(idKey) || cameraProfiles.get(labelKey);
  if (directProfile) {
    return {
      profile: "camera-profile",
      source: directProfile.source || "runtime",
      notes: directProfile.notes || "",
      thresholdDistance: asThreshold(directProfile.thresholdDistance),
      highRisk:
        Boolean(directProfile.highRisk)
        || highRiskCameraIds.has(idKey)
        || highRiskCameraIds.has(labelKey),
      livenessMinScore: asLivenessMinScore(directProfile.livenessMinScore),
    };
  }

  const keywordProfile = resolveKeywordProfile(cameraLabel);
  if (keywordProfile) {
    return keywordProfile;
  }

  return {
    profile: "default",
    source: "default",
    thresholdDistance: asThreshold(DEFAULT_DISTANCE_THRESHOLD),
    highRisk: highRiskCameraIds.has(idKey) || highRiskCameraIds.has(labelKey),
    livenessMinScore: asLivenessMinScore(DEFAULT_LIVENESS_MIN_SCORE),
  };
}

function upsertProfile(cameraId, config = {}) {
  const key = normalizeKey(cameraId);
  if (!key) {
    throw new Error("cameraId is required");
  }

  const profile = {
    thresholdDistance: asThreshold(config.thresholdDistance),
    highRisk: asBoolean(config.highRisk, false),
    livenessMinScore: asLivenessMinScore(config.livenessMinScore),
    notes: String(config.notes || ""),
    source: "runtime",
  };

  cameraProfiles.set(key, profile);

  return {
    cameraId: key,
    ...profile,
  };
}

function getProfiles() {
  return Array.from(cameraProfiles.entries()).map(([cameraId, profile]) => ({
    cameraId,
    thresholdDistance: asThreshold(profile.thresholdDistance),
    highRisk: Boolean(profile.highRisk),
    livenessMinScore: asLivenessMinScore(profile.livenessMinScore),
    notes: String(profile.notes || ""),
    source: String(profile.source || "runtime"),
  }));
}

function getProfilesSummary() {
  const profiles = getProfiles();

  return {
    defaultThreshold: asThreshold(DEFAULT_DISTANCE_THRESHOLD),
    defaultLivenessMinScore: asLivenessMinScore(DEFAULT_LIVENESS_MIN_SCORE),
    minThreshold: MIN_THRESHOLD,
    maxThreshold: MAX_THRESHOLD,
    profileCount: cameraProfiles.size,
    highRiskCount: profiles.filter((profile) => profile.highRisk).length,
    profiles,
  };
}

module.exports = {
  resolveThreshold,
  upsertProfile,
  getProfiles,
  getProfilesSummary,
};
