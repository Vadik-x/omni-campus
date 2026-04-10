const crypto = require("crypto");
const auditLog = require("./auditLog");

const DEFAULT_SIGNING_SECRET = "omni-campus-dev-signing-secret-change-me";
const SIGNING_SECRET = String(
  process.env.OMNI_PAYLOAD_SIGNING_SECRET || DEFAULT_SIGNING_SECRET
).trim();
const SIGNATURE_MAX_AGE_MS = Number(process.env.OMNI_SIGNATURE_MAX_AGE_MS || 15000);
const REQUIRE_SIGNED_DETECTIONS =
  String(process.env.OMNI_REQUIRE_SIGNED_DETECTIONS || "true").toLowerCase() !== "false";
const REQUIRE_SIGNED_SOCKET_DETECTIONS =
  String(process.env.OMNI_REQUIRE_SIGNED_SOCKET_DETECTIONS || "true").toLowerCase() !== "false";
const ALLOW_HEADER_ROLE =
  String(process.env.OMNI_ALLOW_HEADER_ROLE || "true").toLowerCase() !== "false";

const ROLE_LEVELS = {
  viewer: 1,
  operator: 2,
  admin: 3,
};

function normalizeRole(value) {
  const role = String(value || "").trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(ROLE_LEVELS, role)) {
    return role;
  }

  return "viewer";
}

function parseRoleApiKeys() {
  const raw = String(process.env.OMNI_RBAC_KEYS_JSON || "").trim();
  if (!raw) {
    return new Map();
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return new Map();
    }

    const mapped = new Map();
    Object.entries(parsed).forEach(([role, key]) => {
      const normalizedRole = normalizeRole(role);
      const normalizedKey = String(key || "").trim();
      if (!normalizedRole || !normalizedKey) {
        return;
      }

      mapped.set(normalizedKey, normalizedRole);
    });

    return mapped;
  } catch (error) {
    return new Map();
  }
}

const ROLE_API_KEYS = parseRoleApiKeys();

function pickHeader(headers = {}, keys = []) {
  for (const key of keys) {
    const value = headers[key];
    if (Array.isArray(value)) {
      const first = String(value[0] || "").trim();
      if (first) {
        return first;
      }
      continue;
    }

    const normalized = String(value || "").trim();
    if (normalized) {
      return normalized;
    }
  }

  return "";
}

function extractApiKey(headers = {}) {
  const direct = pickHeader(headers, ["x-omni-api-key"]);
  if (direct) {
    return direct;
  }

  const auth = pickHeader(headers, ["authorization"]);
  if (!auth) {
    return "";
  }

  if (/^bearer\s+/i.test(auth)) {
    return auth.replace(/^bearer\s+/i, "").trim();
  }

  return "";
}

function resolveRoleFromApiKey(headers = {}) {
  const apiKey = extractApiKey(headers);
  if (!apiKey) {
    return {
      role: "",
      apiKeyUsed: false,
      authenticated: false,
    };
  }

  const role = ROLE_API_KEYS.get(apiKey) || "";
  return {
    role,
    apiKeyUsed: true,
    authenticated: Boolean(role),
  };
}

function resolveActorFromHeaders(headers = {}, fallback = {}) {
  const apiKeyAuth = resolveRoleFromApiKey(headers);
  const headerRole = normalizeRole(
    pickHeader(headers, ["x-omni-role", "x-role", "x-actor-role"]) || fallback.role
  );

  const role = apiKeyAuth.role || (ALLOW_HEADER_ROLE ? headerRole : "viewer");
  const userId =
    pickHeader(headers, ["x-omni-user", "x-user-id", "x-actor-id"]) ||
    String(fallback.userId || "anonymous").trim() ||
    "anonymous";

  const authMode = apiKeyAuth.role
    ? "api-key"
    : ALLOW_HEADER_ROLE
      ? "header-role"
      : "anonymous";

  return {
    role,
    userId,
    authMode,
    apiKeyUsed: apiKeyAuth.apiKeyUsed,
    authenticated: apiKeyAuth.authenticated || Boolean(ALLOW_HEADER_ROLE),
  };
}

function resolveActorFromRequest(req) {
  return resolveActorFromHeaders(req?.headers || {}, {
    userId: req?.ip || "anonymous",
  });
}

function resolveActorFromSocket(socket) {
  const headers = socket?.handshake?.headers || {};
  const authPayload = socket?.handshake?.auth || {};
  const query = socket?.handshake?.query || {};

  return resolveActorFromHeaders(
    {
      ...headers,
      "x-omni-role": authPayload.role || query.role || headers["x-omni-role"],
      "x-omni-user": authPayload.user || query.user || headers["x-omni-user"],
      "x-omni-api-key": authPayload.apiKey || query.apiKey || headers["x-omni-api-key"],
    },
    {
      userId: socket?.id || "socket-anonymous",
    }
  );
}

function isRoleAllowed(actorRole, allowedRoles = []) {
  const normalizedActor = normalizeRole(actorRole);
  const allowed = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];

  return allowed
    .map((role) => normalizeRole(role))
    .some((role) => ROLE_LEVELS[normalizedActor] >= ROLE_LEVELS[role]);
}

function requireRole(allowedRoles = [], action = "") {
  return (req, res, next) => {
    const actor = req.securityActor || resolveActorFromRequest(req);
    req.securityActor = actor;

    if (isRoleAllowed(actor.role, allowedRoles)) {
      return next();
    }

    auditLog.recordRequestAudit(req, {
      action: action || "rbac.denied",
      status: "rejected",
      target: {
        type: "route",
        id: String(req?.originalUrl || req?.url || ""),
      },
      details: {
        actorRole: actor.role,
        requiredRoles: Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles],
      },
    });

    return res.status(403).json({
      message: "Forbidden",
      action,
      actorRole: actor.role,
      requiredRoles: Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles],
    });
  };
}

function normalizeForSignature(value) {
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : normalizeForSignature(item)));
  }

  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    const normalized = {};

    keys.forEach((key) => {
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

function buildPayloadSignature({ payload = {}, signatureTs, scope = "default" } = {}) {
  if (!SIGNING_SECRET) {
    return "";
  }

  const ts = String(signatureTs || "").trim();
  if (!ts) {
    return "";
  }

  const canonical = canonicalizePayload(payload);
  const basis = `${String(scope || "default").trim()}.${ts}.${canonical}`;
  return crypto.createHmac("sha256", SIGNING_SECRET).update(basis).digest("hex");
}

function safeEqualHex(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(a, b);
}

function verifySignedPayload({
  payload = {},
  signature = "",
  signatureTs = "",
  scope = "default",
  required = REQUIRE_SIGNED_DETECTIONS,
} = {}) {
  const normalizedSignature = String(signature || "").trim();
  const timestampRaw = String(signatureTs || "").trim();
  const timestamp = Number(timestampRaw);

  const provided = Boolean(normalizedSignature && timestampRaw);
  if (!provided) {
    return {
      required,
      provided,
      valid: !required,
      reason: required ? "missing_signature" : "signature_optional",
      scope,
      ageMs: null,
    };
  }

  if (!Number.isFinite(timestamp)) {
    return {
      required,
      provided,
      valid: false,
      reason: "invalid_timestamp",
      scope,
      ageMs: null,
    };
  }

  const now = Date.now();
  const ageMs = Math.abs(now - timestamp);
  if (ageMs > SIGNATURE_MAX_AGE_MS) {
    return {
      required,
      provided,
      valid: false,
      reason: "signature_expired",
      scope,
      ageMs,
    };
  }

  const expected = buildPayloadSignature({
    payload,
    signatureTs: timestampRaw,
    scope,
  });

  const valid = safeEqualHex(expected, normalizedSignature);
  return {
    required,
    provided,
    valid,
    reason: valid ? "ok" : "signature_mismatch",
    scope,
    ageMs,
  };
}

function verifyRequestSignature(
  req,
  {
    payload,
    scope = "default",
    required = REQUIRE_SIGNED_DETECTIONS,
    signatureHeader = "x-omni-signature",
    timestampHeader = "x-omni-signature-ts",
  } = {}
) {
  const headers = req?.headers || {};
  return verifySignedPayload({
    payload: payload === undefined ? req?.body || {} : payload,
    signature: headers[signatureHeader],
    signatureTs: headers[timestampHeader],
    scope,
    required,
  });
}

function getSecuritySummary() {
  return {
    rbac: {
      enabled: true,
      allowHeaderRole: ALLOW_HEADER_ROLE,
      configuredApiKeys: ROLE_API_KEYS.size,
      roles: Object.keys(ROLE_LEVELS),
    },
    signing: {
      requireSignedDetections: REQUIRE_SIGNED_DETECTIONS,
      requireSignedSocketDetections: REQUIRE_SIGNED_SOCKET_DETECTIONS,
      maxAgeMs: SIGNATURE_MAX_AGE_MS,
      configured: Boolean(SIGNING_SECRET),
    },
  };
}

module.exports = {
  normalizeRole,
  isRoleAllowed,
  requireRole,
  resolveActorFromHeaders,
  resolveActorFromRequest,
  resolveActorFromSocket,
  canonicalizePayload,
  buildPayloadSignature,
  verifySignedPayload,
  verifyRequestSignature,
  getSecuritySummary,
  REQUIRE_SIGNED_DETECTIONS,
  REQUIRE_SIGNED_SOCKET_DETECTIONS,
};
