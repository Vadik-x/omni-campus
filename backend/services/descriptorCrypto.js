const crypto = require("crypto");

const ENCRYPTION_PREFIX = "enc:v1:";
const DEFAULT_ENCRYPTION_KEY = "omni-campus-dev-embedding-encryption-key-change-me";
const ENCRYPTION_KEY_MATERIAL = String(
  process.env.OMNI_EMBEDDING_ENCRYPTION_KEY || DEFAULT_ENCRYPTION_KEY
).trim();

function deriveKey(keyMaterial) {
  return crypto.createHash("sha256").update(String(keyMaterial || "")).digest();
}

const ENCRYPTION_KEY = deriveKey(ENCRYPTION_KEY_MATERIAL);

function isEncryptedValue(value) {
  return String(value || "").startsWith(ENCRYPTION_PREFIX);
}

function encryptString(plainText = "") {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([
    cipher.update(String(plainText || ""), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${ENCRYPTION_PREFIX}${iv.toString("base64")}.${authTag.toString("base64")}.${encrypted.toString("base64")}`;
}

function decryptString(cipherText = "") {
  if (!isEncryptedValue(cipherText)) {
    return String(cipherText || "");
  }

  const payload = String(cipherText || "").slice(ENCRYPTION_PREFIX.length);
  const [ivB64, tagB64, encryptedB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !encryptedB64) {
    throw new Error("Invalid encrypted descriptor payload");
  }

  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const encrypted = Buffer.from(encryptedB64, "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}

function stringifyEncrypted(value) {
  return encryptString(JSON.stringify(value));
}

function parseEncrypted(value, fallback) {
  try {
    const plain = decryptString(value);
    return plain ? JSON.parse(plain) : fallback;
  } catch (error) {
    return fallback;
  }
}

module.exports = {
  ENCRYPTION_PREFIX,
  isEncryptedValue,
  encryptString,
  decryptString,
  stringifyEncrypted,
  parseEncrypted,
};
