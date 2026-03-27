const crypto = require("crypto");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const MODEL_NAME = "gemini-2.0-flash";
const CACHE_TTL_MS = 5000;
const RATE_LIMIT_INTERVAL_MS = 6000;
const resultCache = new Map();

let queued = Promise.resolve();
let nextAllowedAt = 0;
let model = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBase64(base64ImageFrame) {
  if (!base64ImageFrame || typeof base64ImageFrame !== "string") {
    return null;
  }

  const dataUriMatch = base64ImageFrame.match(/^data:image\/(?:jpeg|jpg|png);base64,(.+)$/i);
  return dataUriMatch ? dataUriMatch[1] : base64ImageFrame;
}

function createCacheKey(prefix, payload) {
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");

  return `${prefix}:${hash}`;
}

function getFromCache(cacheKey) {
  const cached = resultCache.get(cacheKey);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt < Date.now()) {
    resultCache.delete(cacheKey);
    return null;
  }

  return cached.value;
}

function setCache(cacheKey, value) {
  resultCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

function getModel() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return null;
  }

  if (model) {
    return model;
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  model = genAI.getGenerativeModel({ model: MODEL_NAME });
  return model;
}

function queueWithRateLimit(task) {
  const run = async () => {
    const waitMs = nextAllowedAt - Date.now();
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    try {
      return await task();
    } finally {
      nextAllowedAt = Date.now() + RATE_LIMIT_INTERVAL_MS;
    }
  };

  const taskPromise = queued.then(run, run);
  queued = taskPromise.catch(() => null);
  return taskPromise;
}

function extractJsonObject(rawText) {
  if (!rawText || typeof rawText !== "string") {
    return null;
  }

  const fenced = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : rawText;
  const trimmed = candidate.trim();

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) {
    return null;
  }

  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch (error) {
    return null;
  }
}

async function callGemini(promptText, base64ImageFrame) {
  const currentModel = getModel();
  if (!currentModel) {
    console.error("Gemini API key missing: set GEMINI_API_KEY in .env");
    return null;
  }

  const normalized = normalizeBase64(base64ImageFrame);
  if (!normalized) {
    return null;
  }

  const response = await currentModel.generateContent({
    contents: [
      {
        role: "user",
        parts: [
          { text: promptText },
          {
            inlineData: {
              mimeType: "image/jpeg",
              data: normalized,
            },
          },
        ],
      },
    ],
  });

  return response?.response?.text?.() || null;
}

async function identifyStudent(base64ImageFrame, studentList = []) {
  const cacheKey = createCacheKey("identify", {
    frame: base64ImageFrame,
    students: studentList,
  });
  const cached = getFromCache(cacheKey);
  if (cached) {
    return cached;
  }

  const prompt = [
    "You are a campus security Re-ID system. Given this camera frame and the list of registered students, identify which student (if any) is visible. Return JSON: {studentId: string|null, confidence: number 0-1, location_description: string, is_face_visible: boolean}. If no match return studentId: null.",
    "Registered students (JSON):",
    JSON.stringify(studentList || [], null, 2),
    "Output only valid JSON.",
  ].join("\n\n");

  try {
    const rawText = await queueWithRateLimit(() => callGemini(prompt, base64ImageFrame));
    if (!rawText) {
      return null;
    }

    const parsed = extractJsonObject(rawText);
    if (!parsed) {
      console.error("Gemini identifyStudent parse error: invalid JSON response");
      return null;
    }

    const result = {
      studentId: parsed.studentId ?? null,
      confidence:
        typeof parsed.confidence === "number"
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0,
      location_description:
        typeof parsed.location_description === "string"
          ? parsed.location_description
          : "Unknown",
      is_face_visible: Boolean(parsed.is_face_visible),
    };

    setCache(cacheKey, result);
    return result;
  } catch (error) {
    console.error("Gemini identifyStudent error:", error.message);
    return null;
  }
}

async function analyzeFrame(base64ImageFrame) {
  const cacheKey = createCacheKey("analyze", {
    frame: base64ImageFrame,
  });
  const cached = getFromCache(cacheKey);
  if (cached) {
    return cached;
  }

  const prompt =
    "Analyze this campus camera frame and describe what is visible. Include estimated people count, location type (classroom/corridor/library/lab/outdoor etc.), and any safety or security alerts. Return plain text.";

  try {
    const text = await queueWithRateLimit(() => callGemini(prompt, base64ImageFrame));
    if (!text) {
      return null;
    }

    const result = text.trim();
    setCache(cacheKey, result);
    return result;
  } catch (error) {
    console.error("Gemini analyzeFrame error:", error.message);
    return null;
  }
}

module.exports = {
  identifyStudent,
  analyzeFrame,
};
