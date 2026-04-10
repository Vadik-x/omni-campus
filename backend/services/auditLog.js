const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const logger = require("./logger");

const DATA_DIR = path.join(__dirname, "..", "data");
const AUDIT_FILE = path.join(DATA_DIR, "audit-log.jsonl");
const MAX_IN_MEMORY_AUDIT = Math.max(
  10,
  Math.min(500, Number(process.env.OMNI_IN_MEMORY_AUDIT_LIMIT || 50))
);
const inMemoryAuditLogs = [];

function ensureAuditFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(AUDIT_FILE)) {
    fs.writeFileSync(AUDIT_FILE, "", "utf8");
  }
}

function nowIso() {
  return new Date().toISOString();
}

function createId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${crypto.randomBytes(8).toString("hex")}`;
}

function hashValue(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 20);
}

function summarizeNumericArray(value = []) {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const finite = value
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));

  if (finite.length === 0) {
    return null;
  }

  return {
    type: "numeric-array",
    length: finite.length,
    checksum: hashValue(JSON.stringify(finite)),
  };
}

function scrubDetails(value, depth = 0) {
  if (depth > 4) {
    return "[truncated]";
  }

  if (Array.isArray(value)) {
    const numeric = summarizeNumericArray(value);
    if (numeric && value.length >= 16) {
      return numeric;
    }

    if (value.length > 40) {
      return {
        type: "array",
        length: value.length,
      };
    }

    return value.map((item) => scrubDetails(item, depth + 1));
  }

  if (value && typeof value === "object") {
    const sanitized = {};

    Object.keys(value)
      .sort()
      .forEach((key) => {
        const item = value[key];
        const lowerKey = String(key || "").toLowerCase();

        if (item === undefined) {
          return;
        }

        if (
          lowerKey.includes("password")
          || lowerKey.includes("secret")
          || lowerKey.includes("token")
          || lowerKey.includes("api_key")
          || lowerKey.includes("apiKey")
        ) {
          sanitized[key] = "[redacted]";
          return;
        }

        if (lowerKey.includes("descriptor") || lowerKey.includes("embedding")) {
          const summary = summarizeNumericArray(Array.isArray(item) ? item : []);
          sanitized[key] = summary || "[descriptor-redacted]";
          return;
        }

        sanitized[key] = scrubDetails(item, depth + 1);
      });

    return sanitized;
  }

  if (typeof value === "string" && value.length > 500) {
    return `${value.slice(0, 280)}...[trimmed]`;
  }

  return value;
}

function buildRequestContext(req) {
  const forwarded = String(req?.headers?.["x-forwarded-for"] || "").trim();
  const ip = forwarded ? forwarded.split(",")[0].trim() : req?.ip || "";

  return {
    method: String(req?.method || "").toUpperCase(),
    path: String(req?.originalUrl || req?.url || ""),
    ip: String(ip || "unknown"),
    userAgent: String(req?.headers?.["user-agent"] || "").slice(0, 180),
  };
}

function appendLine(line) {
  ensureAuditFile();
  fs.appendFileSync(AUDIT_FILE, `${line}\n`, "utf8");
}

function pushInMemoryAudit(entry) {
  inMemoryAuditLogs.push(entry);
  if (inMemoryAuditLogs.length > MAX_IN_MEMORY_AUDIT) {
    inMemoryAuditLogs.shift();
  }
}

function isImportantAuditAction(action = "") {
  const normalized = String(action || "").toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    normalized.includes("enroll")
    || normalized.includes("delete")
    || normalized.includes("reindex")
    || normalized.startsWith("students.")
    || normalized.startsWith("recognition.")
  );
}

function recordAudit(event = {}) {
  const entry = {
    id: createId(),
    timestamp: nowIso(),
    action: String(event.action || "unknown.action"),
    status: String(event.status || "info"),
    actor: event.actor
      ? {
          userId: String(event.actor.userId || "anonymous"),
          role: String(event.actor.role || "viewer"),
          authMode: String(event.actor.authMode || "unknown"),
        }
      : {
          userId: "anonymous",
          role: "viewer",
          authMode: "unknown",
        },
    request: event.request
      ? {
          method: String(event.request.method || ""),
          path: String(event.request.path || ""),
          ip: String(event.request.ip || ""),
          userAgent: String(event.request.userAgent || ""),
        }
      : undefined,
    target: event.target
      ? {
          type: String(event.target.type || ""),
          id: String(event.target.id || ""),
        }
      : undefined,
    signature: event.signature
      ? {
          required: Boolean(event.signature.required),
          provided: Boolean(event.signature.provided),
          valid: Boolean(event.signature.valid),
          reason: String(event.signature.reason || ""),
          scope: String(event.signature.scope || ""),
          ageMs:
            event.signature.ageMs === null || event.signature.ageMs === undefined
              ? null
              : Number(event.signature.ageMs),
        }
      : undefined,
    details: scrubDetails(event.details || {}),
  };

  try {
    appendLine(JSON.stringify(entry));
  } catch (error) {
    logger.error({
      service: "api",
      event: "audit.append_failed",
      message: "Failed to append audit log entry",
      error,
      details: {
        action: entry.action,
        status: entry.status,
      },
    });
  }

  pushInMemoryAudit(entry);

  if (isImportantAuditAction(entry.action)) {
    logger.info({
      service: "api",
      event: "audit.important_action",
      message: `Audit action recorded: ${entry.action}`,
      cameraId: entry?.target?.type === "camera" ? entry.target.id : null,
      details: {
        action: entry.action,
        status: entry.status,
        actorRole: entry?.actor?.role || "viewer",
        targetType: entry?.target?.type || "",
        targetId: entry?.target?.id || "",
      },
    });
  }

  return entry;
}

function recordRequestAudit(req, event = {}) {
  return recordAudit({
    ...event,
    actor: event.actor || req?.securityActor,
    request: event.request || buildRequestContext(req),
  });
}

function listAuditLogs({ limit = 200, action = "", status = "" } = {}) {
  ensureAuditFile();

  const normalizedLimit = Math.max(1, Math.min(5000, Number(limit) || 200));
  const filterAction = String(action || "").trim().toLowerCase();
  const filterStatus = String(status || "").trim().toLowerCase();

  const lines = fs
    .readFileSync(AUDIT_FILE, "utf8")
    .split(/\r?\n/)
    .filter(Boolean);

  const parsed = [];

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const item = JSON.parse(lines[index]);
      const actionValue = String(item?.action || "").toLowerCase();
      const statusValue = String(item?.status || "").toLowerCase();

      if (filterAction && !actionValue.includes(filterAction)) {
        continue;
      }

      if (filterStatus && statusValue !== filterStatus) {
        continue;
      }

      parsed.push(item);
      if (parsed.length >= normalizedLimit) {
        break;
      }
    } catch (error) {
      // Ignore malformed lines and continue.
    }
  }

  return parsed;
}

function getAuditSummary() {
  const recent = listAuditLogs({ limit: 500 });
  const statusCounts = recent.reduce((acc, item) => {
    const key = String(item?.status || "unknown");
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return {
    file: AUDIT_FILE,
    recentCount: recent.length,
    inMemoryCount: inMemoryAuditLogs.length,
    latestAt: recent[0]?.timestamp || null,
    statusCounts,
  };
}

function listRecentInMemoryAuditLogs(limit = 50) {
  if (inMemoryAuditLogs.length === 0) {
    return [];
  }

  const normalizedLimit = Math.max(
    1,
    Math.min(inMemoryAuditLogs.length, Number(limit) || 50)
  );

  return inMemoryAuditLogs.slice(-normalizedLimit).reverse();
}

module.exports = {
  AUDIT_FILE,
  buildRequestContext,
  recordAudit,
  recordRequestAudit,
  listAuditLogs,
  listRecentInMemoryAuditLogs,
  getAuditSummary,
};
