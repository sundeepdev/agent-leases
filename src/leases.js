import { randomUUID } from "node:crypto";
import { promises as fs, constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnFileLock, waitForLock, releaseFileLock } from "./flock.js";
import { currentProcessIdentity, decideLiveness, localIdentity, probeProcess } from "./identity.js";
import {
  isResourceName,
  isUuid,
  normalizeNames,
  sanitizeText,
  tokensMatch,
  validateIdentity,
  validateLease,
  validateRequest,
  validateResourceState,
} from "./validate.js";

export const FORMAT_VERSION = 2;
export const REFUSED_EXIT_CODE = 75;

const MAX_ENTRIES = 4096;
const MAX_BYTES = 64 * 1024;
const NOFOLLOW = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

const nowIso = () => new Date().toISOString();

export class LeaseUnavailable extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "LeaseUnavailable";
    this.code = "LEASE_UNAVAILABLE";
    Object.assign(this, details);
  }
}

export class LeaseUncertain extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "LeaseUncertain";
    this.code = "LEASE_UNCERTAIN";
    Object.assign(this, details);
  }
}

function recordPath(directory, id) {
  if (!isUuid(id)) throw new Error("invalid id");
  const filename = path.resolve(directory, `${id}.json`);
  if (path.dirname(filename) !== path.resolve(directory)) throw new Error("invalid id");
  return filename;
}

function resourcePath(directory, resource) {
  if (!isResourceName(resource)) throw new Error("invalid resource name");
  const filename = path.resolve(directory, `${encodeURIComponent(resource)}.json`);
  if (path.dirname(filename) !== path.resolve(directory)) throw new Error("invalid resource name");
  return filename;
}

function publicLease(record) {
  if (record.uncertain) {
    return {
      id: record.id,
      uncertain: true,
      scope: record.scope,
      resource: record.scope === "global" ? null : record.scope,
      reason: record.reason,
      importance: "high",
      interruptible: false,
    };
  }
  const { token, ...rest } = record.lease;
  return { ...rest, liveness: record.liveness, uncertain: false };
}

function publicRequest(request, { includeToken = false } = {}) {
  if (request.uncertain) {
    return { id: request.id, uncertain: true, reason: request.reason, resource: null };
  }
  if (includeToken) return { ...request };
  const { token, ...rest } = request;
  return rest;
}

export class LeaseStore {
  constructor({
    stateDir = process.env.AGENT_LEASES_STATE_DIR || path.join(os.homedir(), ".agent-leases", "demo"),
    isAlive = null,
    now = nowIso,
    lockWaitMs = 5_000,
    lockPublishGraceMs = 5_000,
    testHooks = null,
  } = {}) {
    this.stateDir = path.resolve(stateDir);
    this.leasesDir = path.join(this.stateDir, "leases");
    this.requestsDir = path.join(this.stateDir, "requests");
    this.resourcesDir = path.join(this.stateDir, "resources");
    this.isAlive = isAlive;
    this.now = now;
    this.lockWaitMs = lockWaitMs;
    this.lockPublishGraceMs = lockPublishGraceMs;
    this.testHooks = testHooks;
  }

  async init() {
    const existing = await fs.lstat(this.stateDir).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing?.isSymbolicLink()) throw new Error("state directory must not be a symlink");
    await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const root = await fs.lstat(this.stateDir);
    if (root.isSymbolicLink() || !root.isDirectory()) throw new Error("state directory must be a real directory");
    // Ancestors such as macOS /var -> /private/var may be symlinks. Only the
    // state directory itself must be a real directory.
    const parentReal = await fs.realpath(path.dirname(this.stateDir));
    const selfReal = await fs.realpath(this.stateDir);
    if (selfReal !== path.join(parentReal, path.basename(this.stateDir))) {
      throw new Error("state directory must not be a symlink");
    }
    await fs.chmod(this.stateDir, 0o700);
    for (const directory of [this.leasesDir, this.requestsDir, this.resourcesDir]) {
      const current = await fs.lstat(directory).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (current?.isSymbolicLink()) throw new Error("lease store subdirectory must not be a symlink");
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const created = await fs.lstat(directory);
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw new Error("lease store subdirectory must be a real directory");
      }
      await fs.chmod(directory, 0o700);
    }
  }

  async acquire({
    kind,
    resource = "demo-resource",
    purpose,
    where = process.cwd(),
    pid = process.pid,
    expectedUntil = null,
    interruptible = false,
    importance = "normal",
    operation = "change the resource",
    urgency = "normal",
    message = "",
  } = {}) {
    if (kind !== "read" && kind !== "write") throw new Error("kind must be read or write");
    if (typeof purpose !== "string" || purpose.length === 0 || purpose.length > 500 || purpose.includes("\u0000")) {
      throw new Error("purpose is required");
    }
    if (!isResourceName(resource)) throw new Error("invalid resource name");
    if (importance !== "normal" && importance !== "high") throw new Error("importance must be normal or high");
    if (urgency !== "normal" && urgency !== "urgent") throw new Error("urgency must be normal or urgent");
    if (typeof operation !== "string" || operation.length === 0 || operation.length > 200 || operation.includes("\u0000")) {
      throw new Error("operation is invalid");
    }
    if (message !== "" && (typeof message !== "string" || message.length > 1000 || message.includes("\u0000"))) {
      throw new Error("message is invalid");
    }
    if (urgency === "urgent" && (typeof message !== "string" || message.trim() === "")) {
      throw new Error("an urgent request requires a message");
    }
    if (typeof interruptible !== "boolean") throw new Error("interruptible must be a boolean");
    if (expectedUntil !== null && (typeof expectedUntil !== "string" || !Number.isFinite(Date.parse(expectedUntil)) || expectedUntil.length > 40)) {
      throw new Error("expectedUntil must be a timestamp or null");
    }
    if (typeof where !== "string" || where.length > 1000 || where.includes("\u0000")) throw new Error("where is invalid");
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("pid is invalid");
    const identity = currentProcessIdentity(pid);
    if (!validateIdentity(identity, pid)) {
      throw new Error("refusing to acquire a lease without a complete process identity for the holder");
    }

    await this.init();
    return this.#withLock(async () => {
      const records = await this.#readLeaseFiles();
      await this.#reclaimDead(records);
      const active = records.filter((record) => record.uncertain || record.liveness !== "dead");
      const uncertain = active.filter((record) => record.uncertain && (record.scope === "global" || record.scope === resource));
      if (uncertain.length > 0) {
        const first = uncertain[0];
        throw new LeaseUncertain(
          `refusing to acquire ${resource}: ${first.reason}${first.id ? ` (${first.id})` : ""}`,
          { reason: "uncertain-ownership", holders: uncertain.map(publicLease) },
        );
      }
      const relevant = active.filter((record) => !record.uncertain && record.lease.resource === resource);
      const activeWrite = relevant.find((record) => record.lease.kind === "write");
      if (activeWrite) {
        throw new LeaseUnavailable(
          `resource ${resource} is held for writing by ${sanitizeText(activeWrite.lease.purpose)}`,
          { reason: "write-held", holders: [publicLease(activeWrite)] },
        );
      }
      const readers = relevant.filter((record) => record.lease.kind === "read");
      if (kind === "write" && readers.length > 0) {
        const request = await this.#reuseOrCreateRequest({
          resource,
          operation,
          urgency,
          message: message || `Requesting permission to ${operation}`,
          pid,
          where,
          purpose,
          startId: identity.startId,
          platform: identity.platform,
        });
        throw new LeaseUnavailable(
          `resource ${resource} has ${readers.length} active reader(s); request ${request.id}`,
          {
            reason: "readers-active",
            holders: readers.map(publicLease),
            request,
          },
        );
      }

      const lease = {
        formatVersion: FORMAT_VERSION,
        id: randomUUID(),
        token: randomUUID(),
        resource,
        pid,
        identity,
        kind,
        purpose,
        where,
        startedAt: this.now(),
        // An estimate for humans. Never a TTL and never a reason to drop a live holder.
        expectedUntil: expectedUntil || null,
        interruptible,
        importance,
      };
      await this.#writeJson(recordPath(this.leasesDir, lease.id), lease);
      return lease;
    });
  }

  async withLease(spec, operation) {
    if (typeof operation !== "function") throw new Error("withLease requires a function");
    const lease = await this.acquire(spec);
    let failure;
    try {
      return await operation(lease);
    } catch (error) {
      failure = error;
      return undefined;
    } finally {
      try {
        await this.release(lease.id, lease.token);
      } catch (error) {
        if (!failure) failure = error;
      }
      if (failure) throw failure;
    }
  }

  async supervise(id, token, pid) {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("supervised pid is invalid");
    const identity = currentProcessIdentity(pid);
    if (!validateIdentity(identity, pid)) {
      throw new Error("supervised process identity is incomplete or the process is not alive");
    }
    recordPath(this.leasesDir, id);
    await this.init();
    return this.#withLock(async () => {
      const loaded = await this.#readLeaseFile(recordPath(this.leasesDir, id), id);
      if (loaded.missing) throw new Error("lease not found");
      if (loaded.uncertain) throw new Error(`cannot supervise this lease: ${loaded.reason}`);
      if (!tokensMatch(token, loaded.lease.token)) throw new Error("lease token does not match");
      if (this.#liveness(loaded.lease) === "dead") throw new Error("lease holder is not alive");
      const next = {
        ...loaded.lease,
        supervisor: loaded.lease.supervisor || loaded.lease.identity,
        identity,
        pid,
      };
      await this.#writeJson(loaded.filename, next);
      return publicLease({ lease: next, liveness: "alive" });
    });
  }

  async listLeases({ clean = false } = {}) {
    await this.init();
    if (!clean) return this.#publicLeases(await this.#readLeaseFiles());
    return this.#withLock(async () => {
      const records = await this.#readLeaseFiles();
      await this.#reclaimDead(records);
      return this.#publicLeases(records.filter((record) => record.uncertain || record.liveness !== "dead"));
    });
  }

  async reclaim() {
    await this.init();
    return this.#withLock(async () => {
      const records = await this.#readLeaseFiles();
      const removed = [];
      for (const record of records) {
        if (record.uncertain || record.liveness !== "dead") continue;
        await fs.unlink(record.filename).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
        removed.push(record.id);
      }
      return { removed };
    });
  }

  async listRequests() {
    await this.init();
    const records = await this.#readRequestFiles();
    return records
      .map((record) => publicRequest(record.request ? { ...record.request } : record))
      .sort((left, right) => String(left.requestedAt).localeCompare(String(right.requestedAt)));
  }

  async release(id, token) {
    const filename = recordPath(this.leasesDir, id);
    await this.init();
    return this.#withLock(async () => {
      const loaded = await this.#readLeaseFile(filename, id);
      if (loaded.missing) return false;
      if (loaded.uncertain) throw new Error(`cannot release this lease: ${loaded.reason}`);
      if (!tokensMatch(token, loaded.lease.token)) throw new Error("lease token does not match");
      await fs.unlink(filename);
      return true;
    });
  }

  async withdrawRequest(id, token) {
    const filename = recordPath(this.requestsDir, id);
    await this.init();
    return this.#withLock(async () => {
      const loaded = await this.#readRequestFile(filename, id);
      if (loaded.missing) return false;
      if (loaded.uncertain) throw new Error(`cannot withdraw this request: ${loaded.reason}`);
      if (!tokensMatch(token, loaded.request.token)) throw new Error("request token does not match");
      await fs.unlink(filename);
      return true;
    });
  }

  async resourceState(resource = "demo-resource") {
    if (!isResourceName(resource)) throw new Error("invalid resource name");
    await this.init();
    const filename = resourcePath(this.resourcesDir, resource);
    let stat;
    try {
      stat = await fs.lstat(filename);
    } catch (error) {
      if (error.code === "ENOENT") return absentResource(resource);
      return uncertainResource(resource, error.code || error.message);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) return uncertainResource(resource, "resource state is not a regular file");
    if (stat.size > MAX_BYTES) return uncertainResource(resource, "resource state exceeds the size limit");
    let parsed;
    try {
      parsed = JSON.parse(await readRegularFile(filename));
    } catch (error) {
      if (error.code === "ENOENT") return absentResource(resource);
      return uncertainResource(resource, error.code || error.message);
    }
    const validated = validateResourceState(parsed, resource);
    if (!validated.ok) return uncertainResource(resource, validated.reason);
    return { absent: false, uncertain: false, ...validated.state };
  }

  async setResourceState({
    resource = "demo-resource",
    applied = [],
    builtBy = "manual demo setup",
    leaseId,
    token,
  } = {}) {
    if (!isUuid(leaseId)) throw new Error("a live write lease id is required");
    if (typeof token !== "string" || token.length === 0) throw new Error("a live write lease token is required");
    const names = normalizeNames(applied);
    if (builtBy !== null && (typeof builtBy !== "string" || builtBy.length === 0 || builtBy.length > 200 || builtBy.includes("\u0000"))) {
      throw new Error("builtBy is invalid");
    }
    await this.init();
    return this.#withLock(async () => {
      const loaded = await this.#readLeaseFile(recordPath(this.leasesDir, leaseId), leaseId);
      if (loaded.missing || loaded.uncertain) throw new Error("a live write lease for this resource is required");
      const lease = loaded.lease;
      if (!tokensMatch(token, lease.token) || lease.kind !== "write" || lease.resource !== resource) {
        throw new Error("a live write lease for this resource is required");
      }
      if (this.#liveness(lease) !== "alive") throw new Error("write lease is not live");
      return this.#writeResource(resource, names, builtBy);
    });
  }

  async seedResourceState({ resource = "demo-resource", applied = [], builtBy = "manual demo setup" } = {}) {
    const names = normalizeNames(applied);
    if (builtBy !== null && (typeof builtBy !== "string" || builtBy.length === 0 || builtBy.length > 200 || builtBy.includes("\u0000"))) {
      throw new Error("builtBy is invalid");
    }
    await this.init();
    return this.#withLock(async () => this.#writeResource(resource, names, builtBy));
  }

  async preflight({ resource = "demo-resource", expected = [] } = {}) {
    const wanted = normalizeNames(expected);
    const state = await this.resourceState(resource);
    if (state.uncertain) {
      return {
        resource,
        outcome: "unknown",
        expected: wanted,
        actual: [],
        missing: [],
        extra: [],
        builtBy: null,
        updatedAt: null,
        reason: state.reason,
      };
    }
    if (state.absent) {
      return {
        resource,
        outcome: "none",
        expected: wanted,
        actual: [],
        missing: wanted,
        extra: [],
        builtBy: null,
        updatedAt: null,
        reason: "resource state is absent",
      };
    }
    const actual = state.applied.map((item) => item.name);
    const actualSet = new Set(actual);
    const wantedSet = new Set(wanted);
    const missing = wanted.filter((item) => !actualSet.has(item));
    const extra = actual.filter((item) => !wantedSet.has(item));
    let outcome = "match";
    if (actual.length === 0 && wanted.length > 0) outcome = "none";
    else if (missing.length && extra.length) outcome = "behind+ahead";
    else if (missing.length) outcome = "behind";
    else if (extra.length) outcome = "ahead";
    return {
      resource,
      outcome,
      expected: wanted,
      actual,
      missing,
      extra,
      builtBy: state.builtBy,
      updatedAt: state.updatedAt,
    };
  }

  async status() {
    const leases = await this.listLeases({ clean: false });
    const requests = await this.listRequests();
    const resources = {};
    const resourceFiles = await fs.readdir(this.resourcesDir);
    for (const filename of resourceFiles.filter((name) => name.endsWith(".json"))) {
      const parsedName = safeResourceName(filename.slice(0, -5));
      if (!parsedName) {
        resources[filename] = uncertainResource(null, "resource filename is not a resource name");
        continue;
      }
      resources[parsedName] = await this.resourceState(parsedName);
    }
    for (const lease of leases) {
      if (lease.uncertain || !lease.resource || resources[lease.resource]) continue;
      resources[lease.resource] = await this.resourceState(lease.resource);
    }
    for (const request of requests) {
      if (request.uncertain || !request.resource || resources[request.resource]) continue;
      resources[request.resource] = await this.resourceState(request.resource);
    }
    return { stateDir: this.stateDir, resources, leases, requests };
  }

  async #writeResource(resource, names, builtBy) {
    const timestamp = this.now();
    const state = {
      formatVersion: FORMAT_VERSION,
      resource,
      applied: names.map((name) => ({ name, appliedAt: timestamp })),
      builtBy,
      updatedAt: timestamp,
    };
    await this.#writeJson(resourcePath(this.resourcesDir, resource), state);
    return state;
  }

  async #publicLeases(records) {
    return records
      .filter((record) => record.uncertain || record.liveness !== "dead")
      .map(publicLease);
  }

  async #readLeaseFiles() {
    const names = await fs.readdir(this.leasesDir);
    if (names.length > MAX_ENTRIES) {
      return [{
        uncertain: true,
        scope: "global",
        reason: "lease directory exceeds the supported record count",
        id: null,
      }];
    }
    const records = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      const filename = path.resolve(this.leasesDir, name);
      if (path.dirname(filename) !== path.resolve(this.leasesDir)) {
        records.push({ uncertain: true, scope: "global", reason: "lease path escapes the lease directory", id: null });
        continue;
      }
      if (this.testHooks?.onLeaseFilename) await this.testHooks.onLeaseFilename(filename);
      records.push(await this.#readLeaseFile(filename, id));
    }
    return records.filter((record) => !record.missing);
  }

  async #readLeaseFile(filename, id) {
    const inspected = await inspectRecord(filename);
    if (inspected.missing) return { missing: true };
    if (inspected.uncertain) return { uncertain: true, scope: "global", reason: inspected.reason, id: isUuid(id) ? id : null, filename };
    if (!isUuid(id)) {
      return { uncertain: true, scope: "global", reason: "lease filename is not a canonical id", id: null, filename };
    }
    let parsed;
    try {
      parsed = JSON.parse(inspected.text);
    } catch (error) {
      return { uncertain: true, scope: "global", reason: `unreadable lease file (${error.message})`, id, filename };
    }
    const validated = validateLease(parsed, id);
    if (!validated.ok) return { uncertain: true, scope: validated.scope, reason: validated.reason, id, filename };
    return {
      uncertain: false,
      lease: validated.lease,
      liveness: this.#liveness(validated.lease),
      filename,
      id,
    };
  }

  async #readRequestFiles() {
    const names = await fs.readdir(this.requestsDir);
    const records = [];
    if (names.length > MAX_ENTRIES) {
      return [{ request: null, uncertain: true, id: null, reason: "request directory exceeds the supported record count" }];
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      const filename = path.resolve(this.requestsDir, name);
      const loaded = await this.#readRequestFile(filename, id);
      if (!loaded.missing) records.push(loaded);
    }
    return records;
  }

  async #readRequestFile(filename, id) {
    const inspected = await inspectRecord(filename);
    if (inspected.missing) return { missing: true };
    if (inspected.uncertain || !isUuid(id)) {
      return { uncertain: true, request: null, id: isUuid(id) ? id : null, reason: inspected.reason || "request filename is not a canonical id" };
    }
    let parsed;
    try {
      parsed = JSON.parse(inspected.text);
    } catch (error) {
      return { uncertain: true, request: null, id, reason: `unreadable request file (${error.message})` };
    }
    const validated = validateRequest(parsed, id);
    if (!validated.ok) return { uncertain: true, request: null, id, reason: validated.reason };
    return { uncertain: false, request: validated.request, id };
  }

  async #reclaimDead(records) {
    for (const record of records) {
      if (record.uncertain || record.liveness !== "dead" || !record.filename) continue;
      await fs.unlink(record.filename).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  #liveness(lease) {
    if (this.isAlive) {
      try {
        const verdict = this.isAlive(lease.pid, lease);
        if (verdict === true || verdict === "alive") return "alive";
        if (verdict === false || verdict === "dead") return "dead";
        if (verdict === "unknown") return "unknown";
      } catch {
        return "unknown";
      }
      return "unknown";
    }
    return decideLiveness(lease.identity, localIdentity(), probeProcess(lease.identity?.pid));
  }

  async #reuseOrCreateRequest({ resource, operation, urgency, message, pid, where, purpose, startId, platform }) {
    const records = await this.#readRequestFiles();
    const existing = records.find((record) => {
      if (record.uncertain || !record.request) return false;
      const request = record.request;
      const requester = request.requestedBy || {};
      return request.resource === resource
        && request.operation === operation
        && requester.pid === pid
        && requester.startId === startId
        && requester.purpose === purpose
        && requester.where === where;
    });
    if (existing) return existing.request;
    const request = {
      formatVersion: FORMAT_VERSION,
      id: randomUUID(),
      token: randomUUID(),
      resource,
      operation,
      urgency,
      message,
      requestedBy: { pid, where, purpose, platform, startId },
      requestedAt: this.now(),
    };
    await this.#writeJson(recordPath(this.requestsDir, request.id), request);
    return request;
  }

  async #withLock(fn) {
    await this.init();
    const lockPath = path.join(this.stateDir, "lock");
    const child = spawnFileLock(lockPath);
    let outcome;
    try {
      outcome = await waitForLock(child, this.lockWaitMs);
    } catch (error) {
      await releaseFileLock(child);
      throw error;
    }
    if (outcome === "timeout") {
      await releaseFileLock(child);
      throw new LeaseUnavailable("timed out waiting for the lease store lock", { reason: "lock-timeout" });
    }
    try {
      return await fn();
    } finally {
      await releaseFileLock(child);
    }
  }

  async #writeJson(filename, value) {
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.chmod(temporary, 0o600);
      await fs.rename(temporary, filename);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
}

function absentResource(resource) {
  return {
    absent: true,
    uncertain: false,
    formatVersion: FORMAT_VERSION,
    resource,
    applied: [],
    builtBy: null,
    updatedAt: null,
  };
}

function uncertainResource(resource, reason) {
  return {
    absent: false,
    uncertain: true,
    resource,
    reason,
    applied: [],
    builtBy: null,
    updatedAt: null,
  };
}

function safeResourceName(encoded) {
  try {
    const name = decodeURIComponent(encoded);
    return isResourceName(name) ? name : null;
  } catch {
    return null;
  }
}

async function inspectRecord(filename) {
  let stat;
  try {
    stat = await fs.lstat(filename);
  } catch (error) {
    if (error.code === "ENOENT") return { missing: true };
    return { uncertain: true, reason: `unreadable record (${error.code || error.message})` };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return { uncertain: true, reason: "record path is not a regular file" };
  }
  if (stat.size > MAX_BYTES) return { uncertain: true, reason: "record exceeds the size limit" };
  try {
    return { text: await readRegularFile(filename) };
  } catch (error) {
    if (error.code === "ENOENT") return { missing: true };
    return { uncertain: true, reason: `unreadable record (${error.code || error.message})` };
  }
}

async function readRegularFile(filename) {
  const handle = await fs.open(filename, NOFOLLOW);
  try {
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}
