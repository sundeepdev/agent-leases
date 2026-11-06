import { timingSafeEqual } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RESOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const APPLIED_NAME = /^[A-Za-z0-9._:-]{1,128}$/;
const PID_NAMESPACE = /^pid:\[\d+\]$/;

export function isUuid(value) {
  return typeof value === "string" && UUID.test(value);
}

export function isResourceName(value) {
  return typeof value === "string" && RESOURCE_NAME.test(value);
}

export function isAppliedName(value) {
  return typeof value === "string" && APPLIED_NAME.test(value);
}

export function isTimestamp(value) {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}

export function isCleanString(value, max, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || value.includes("\u0000") || value.length > max) return false;
  return allowEmpty || value.length > 0;
}

export function sanitizeText(value) {
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, (character) => {
    return `\\u${character.charCodeAt(0).toString(16).padStart(2, "0")}`;
  });
}

export function tokensMatch(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length || leftBuffer.length === 0) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function validateIdentity(identity, pid) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return false;
  if (identity.pid !== pid || !Number.isInteger(pid) || pid <= 0) return false;
  if (identity.platform !== "linux" && identity.platform !== "darwin") return false;
  if (!isCleanString(identity.machineId, 128)) return false;
  if (!isCleanString(identity.bootId, 256)) return false;
  if (!isCleanString(identity.startId, 128)) return false;
  if (identity.platform === "linux") {
    if (typeof identity.pidNamespace !== "string" || !PID_NAMESPACE.test(identity.pidNamespace)) return false;
  } else if (identity.pidNamespace != null) {
    return false;
  }
  return true;
}

function scopeOf(value) {
  return value && isResourceName(value.resource) ? value.resource : "global";
}

export function validateLease(value, filenameId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, scope: "global", reason: "lease record is not an object" };
  }
  const scope = scopeOf(value);
  if (value.formatVersion !== 2) {
    return { ok: false, scope, reason: "unsupported lease format version" };
  }
  if (!isUuid(filenameId) || value.id !== filenameId) {
    return { ok: false, scope, reason: "lease id does not match its file" };
  }
  if (!isUuid(value.token)) return { ok: false, scope, reason: "lease token is invalid" };
  if (!isResourceName(value.resource)) return { ok: false, scope: "global", reason: "lease resource is invalid" };
  if (value.kind !== "read" && value.kind !== "write") return { ok: false, scope, reason: "lease kind is invalid" };
  if (!isCleanString(value.purpose, 500)) return { ok: false, scope, reason: "lease purpose is invalid" };
  if (!isCleanString(value.where, 1000, { allowEmpty: true })) return { ok: false, scope, reason: "lease location is invalid" };
  if (!Number.isInteger(value.pid) || value.pid <= 0) return { ok: false, scope, reason: "lease pid is invalid" };
  if (!validateIdentity(value.identity, value.pid)) return { ok: false, scope, reason: "lease process identity is invalid" };
  if (value.supervisor !== undefined && !validateIdentity(value.supervisor, value.supervisor?.pid)) {
    return { ok: false, scope, reason: "supervisor identity is invalid" };
  }
  if (!isTimestamp(value.startedAt)) return { ok: false, scope, reason: "lease startedAt is invalid" };
  if (value.expectedUntil !== null && !isTimestamp(value.expectedUntil)) {
    return { ok: false, scope, reason: "lease expectedUntil is invalid" };
  }
  if (typeof value.interruptible !== "boolean") return { ok: false, scope, reason: "lease interruptible flag is invalid" };
  if (value.importance !== "normal" && value.importance !== "high") {
    return { ok: false, scope, reason: "lease importance is invalid" };
  }
  return { ok: true, lease: value };
}

export function validateRequest(value, filenameId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "request record is not an object" };
  }
  if (value.formatVersion !== 2) return { ok: false, reason: "unsupported request format version" };
  if (!isUuid(filenameId) || value.id !== filenameId) return { ok: false, reason: "request id does not match its file" };
  if (!isUuid(value.token)) return { ok: false, reason: "request token is invalid" };
  if (!isResourceName(value.resource)) return { ok: false, reason: "request resource is invalid" };
  if (!isCleanString(value.operation, 200)) return { ok: false, reason: "request operation is invalid" };
  if (value.urgency !== "normal" && value.urgency !== "urgent") return { ok: false, reason: "request urgency is invalid" };
  if (!isCleanString(value.message, 1000)) return { ok: false, reason: "request message is invalid" };
  if (!isTimestamp(value.requestedAt)) return { ok: false, reason: "request timestamp is invalid" };
  const requester = value.requestedBy;
  if (!requester || typeof requester !== "object" || Array.isArray(requester)) {
    return { ok: false, reason: "request owner is invalid" };
  }
  if (!Number.isInteger(requester.pid) || requester.pid <= 0) return { ok: false, reason: "request owner pid is invalid" };
  if (!isCleanString(requester.purpose, 500)) return { ok: false, reason: "request owner purpose is invalid" };
  if (!isCleanString(requester.where, 1000, { allowEmpty: true })) return { ok: false, reason: "request owner location is invalid" };
  return { ok: true, request: value };
}

export function validateResourceState(value, resource) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "resource state is not an object" };
  }
  if (value.formatVersion !== 2) return { ok: false, reason: "unsupported resource state format version" };
  if (value.resource !== resource || !isResourceName(resource)) {
    return { ok: false, reason: "resource state name does not match its file" };
  }
  if (!Array.isArray(value.applied) || value.applied.length > 1000) {
    return { ok: false, reason: "resource applied list is invalid" };
  }
  for (const item of value.applied) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, reason: "resource applied entry is invalid" };
    }
    if (!isAppliedName(item.name) || !isTimestamp(item.appliedAt)) {
      return { ok: false, reason: "resource applied entry is invalid" };
    }
  }
  if (value.builtBy !== null && !isCleanString(value.builtBy, 200)) {
    return { ok: false, reason: "resource builtBy is invalid" };
  }
  if (value.updatedAt !== null && !isTimestamp(value.updatedAt)) {
    return { ok: false, reason: "resource updatedAt is invalid" };
  }
  return { ok: true, state: value };
}

export function normalizeNames(values) {
  if (!Array.isArray(values)) throw new Error("names must be a list");
  const names = [];
  for (const value of values) {
    if (!isAppliedName(value)) throw new Error(`invalid name: ${typeof value === "string" ? value : typeof value}`);
    if (!names.includes(value)) names.push(value);
  }
  names.sort();
  return names;
}
