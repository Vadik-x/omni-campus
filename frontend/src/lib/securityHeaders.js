const DEFAULT_ROLE = import.meta.env.VITE_OMNI_ROLE || "admin";
const DEFAULT_USER = import.meta.env.VITE_OMNI_USER || "dashboard-operator";
const API_KEY = import.meta.env.VITE_OMNI_API_KEY || "";
const SIGNING_SECRET =
  import.meta.env.VITE_OMNI_SIGNING_SECRET || "omni-campus-dev-signing-secret-change-me";
const SIGNING_ENABLED =
  String(import.meta.env.VITE_OMNI_SIGNING_ENABLED || "true").toLowerCase() !== "false";

let cachedSecret = "";
let cachedKeyPromise = null;

function readLocalStorageValue(key) {
  if (typeof window === "undefined") {
    return "";
  }

  try {
    return String(localStorage.getItem(key) || "").trim();
  } catch (error) {
    return "";
  }
}

function normalizeRole(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["viewer", "operator", "admin"].includes(normalized)) {
    return normalized;
  }

  return "viewer";
}

export function getActiveRole() {
  const fromStorage = readLocalStorageValue("omni:auth:role");
  return normalizeRole(fromStorage || DEFAULT_ROLE);
}

export function getActiveUser() {
  return readLocalStorageValue("omni:auth:user") || DEFAULT_USER;
}

export function getAuthHeaders(extraHeaders = {}) {
  const headers = {
    "X-Omni-Role": getActiveRole(),
    "X-Omni-User": getActiveUser(),
    ...extraHeaders,
  };

  const apiKey = readLocalStorageValue("omni:auth:apiKey") || API_KEY;
  if (apiKey) {
    headers["X-Omni-Api-Key"] = apiKey;
  }

  return headers;
}

export function getSocketAuthPayload() {
  const payload = {
    role: getActiveRole(),
    user: getActiveUser(),
  };

  const apiKey = readLocalStorageValue("omni:auth:apiKey") || API_KEY;
  if (apiKey) {
    payload.apiKey = apiKey;
  }

  return payload;
}

function normalizeForSignature(value) {
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : normalizeForSignature(item)));
  }

  if (value && typeof value === "object") {
    const normalized = {};

    Object.keys(value)
      .sort()
      .forEach((key) => {
        const item = value[key];
        if (item === undefined || typeof item === "function") {
          return;
        }

        normalized[key] = normalizeForSignature(item);
      });

    return normalized;
  }

  if (typeof value === "number" && !Number.isFinite(value)) {
    return null;
  }

  return value;
}

function canonicalizePayload(payload) {
  return JSON.stringify(normalizeForSignature(payload || {}));
}

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("");
}

async function getSigningKey(secret) {
  if (cachedKeyPromise && cachedSecret === secret) {
    return cachedKeyPromise;
  }

  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto API is unavailable for payload signing");
  }

  const encoder = new TextEncoder();
  cachedSecret = secret;
  cachedKeyPromise = globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );

  return cachedKeyPromise;
}

async function createSignature({ payload, scope, signatureTs }) {
  const secret = String(SIGNING_SECRET || "").trim();
  if (!SIGNING_ENABLED || !secret) {
    return "";
  }

  const ts = String(signatureTs || "").trim();
  if (!ts) {
    return "";
  }

  const canonical = canonicalizePayload(payload);
  const basis = `${String(scope || "default").trim()}.${ts}.${canonical}`;

  const key = await getSigningKey(secret);
  const encoder = new TextEncoder();
  const signatureBuffer = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(basis)
  );

  return toHex(signatureBuffer);
}

export async function buildSignedHeaders({ payload, scope, headers = {} } = {}) {
  const signedHeaders = getAuthHeaders(headers);
  if (!SIGNING_ENABLED) {
    return signedHeaders;
  }

  const signatureTs = String(Date.now());
  const signature = await createSignature({
    payload,
    scope,
    signatureTs,
  });

  signedHeaders["X-Omni-Signature"] = signature;
  signedHeaders["X-Omni-Signature-Ts"] = signatureTs;

  return signedHeaders;
}

export async function createSignedSocketPayload(payload = {}, scope = "socket.face:detected") {
  if (!SIGNING_ENABLED) {
    return {
      ...payload,
    };
  }

  const signatureTs = String(Date.now());
  const signature = await createSignature({
    payload,
    scope,
    signatureTs,
  });

  return {
    ...payload,
    signature,
    signatureTs,
  };
}
