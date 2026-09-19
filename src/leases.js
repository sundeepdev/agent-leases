import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const FORMAT_VERSION = 1;
export const REFUSED_EXIT_CODE = 75;

const fileFor = (directory, id) => path.join(directory, `${id}.json`);
const nowIso = () => new Date().toISOString();

export class LeaseUnavailable extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "LeaseUnavailable";
    this.code = "LEASE_UNAVAILABLE";
    Object.assign(this, details);
  }
}

export class LeaseStore {
  constructor({
    stateDir = process.env.AGENT_LEASES_STATE_DIR || path.join(os.homedir(), ".agent-leases", "demo"),
    isAlive = defaultIsAlive,
    now = nowIso,
  } = {}) {
    this.stateDir = path.resolve(stateDir);
    this.leasesDir = path.join(this.stateDir, "leases");
    this.requestsDir = path.join(this.stateDir, "requests");
    this.resourcesDir = path.join(this.stateDir, "resources");
    this.isAlive = isAlive;
    this.now = now;
  }

  async init() {
    await Promise.all([
      fs.mkdir(this.leasesDir, { recursive: true }),
      fs.mkdir(this.requestsDir, { recursive: true }),
      fs.mkdir(this.resourcesDir, { recursive: true }),
    ]);
  }

  async acquire({
    kind,
    resource = "demo-resource",
    purpose,
    where = process.cwd(),
    pid = process.pid,
    expectedUntil,
    interruptible = false,
    importance = "normal",
    operation = "change the resource",
    urgency = "normal",
    message = "",
  }) {
    await this.init();
    if (kind !== "read" && kind !== "write") throw new Error("kind must be read or write");
    if (!purpose) throw new Error("purpose is required");
    if (importance !== "normal" && importance !== "high") throw new Error("importance must be normal or high");
    const leases = await this.listLeases();
    const sameResource = leases.filter((lease) => lease.resource === resource);
    const activeWrite = sameResource.find((lease) => lease.kind === "write");
    if (activeWrite) {
      throw new LeaseUnavailable(
        `resource ${resource} is held for writing by ${activeWrite.purpose}`,
        { holders: [activeWrite] },
      );
    }
    const readers = sameResource.filter((lease) => lease.kind === "read");
    if (kind === "write" && readers.length > 0) {
      const request = {
        formatVersion: FORMAT_VERSION,
        id: randomUUID(),
        resource,
        operation,
        urgency,
        message: message || `Requesting permission to ${operation}`,
        requestedBy: { pid, where, purpose },
        requestedAt: this.now(),
      };
      await this.#writeJson(fileFor(this.requestsDir, request.id), request);
      throw new LeaseUnavailable(
        `resource ${resource} has ${readers.length} active reader(s); request ${request.id} was posted`,
        { holders: readers, request },
      );
    }

    const lease = {
      formatVersion: FORMAT_VERSION,
      id: randomUUID(),
      token: randomUUID(),
      resource,
      pid,
      kind,
      purpose,
      where,
      startedAt: this.now(),
      expectedUntil: expectedUntil || null,
      interruptible: Boolean(interruptible),
      importance,
    };
    await this.#writeJson(fileFor(this.leasesDir, lease.id), lease);
    return lease;
  }

  async listLeases({ clean = true } = {}) {
    await this.init();
    const entries = await fs.readdir(this.leasesDir);
    const leases = [];
    for (const entry of entries.filter((name) => name.endsWith(".json"))) {
      const filename = fileFor(this.leasesDir, entry.slice(0, -5));
      let lease;
      try {
        lease = JSON.parse(await fs.readFile(filename, "utf8"));
        if (lease.formatVersion !== FORMAT_VERSION) throw new Error("unknown format version");
      } catch (error) {
        leases.push({
          id: entry.slice(0, -5),
          resource: "unknown",
          kind: "read",
          purpose: `unreadable lease file (${error.message})`,
          corrupt: true,
          interruptible: false,
          importance: "high",
        });
        continue;
      }
      if (clean && !this.isAlive(lease.pid)) {
        await fs.rm(filename, { force: true });
        continue;
      }
      leases.push(lease);
    }
    return leases;
  }

  async listRequests() {
    await this.init();
    const entries = await fs.readdir(this.requestsDir);
    const requests = [];
    for (const entry of entries.filter((name) => name.endsWith(".json"))) {
      try {
        const request = JSON.parse(await fs.readFile(fileFor(this.requestsDir, entry.slice(0, -5)), "utf8"));
        if (request.formatVersion !== FORMAT_VERSION) throw new Error("unknown format version");
        requests.push(request);
      } catch (error) {
        requests.push({
          id: entry.slice(0, -5),
          resource: "unknown",
          message: `unreadable request file (${error.message})`,
          corrupt: true,
        });
      }
    }
    return requests.sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt)));
  }

  async release(id, token) {
    const filename = fileFor(this.leasesDir, id);
    const lease = await this.#readJson(filename);
    if (!lease) return false;
    if (lease.formatVersion !== FORMAT_VERSION) throw new Error("cannot release an unknown lease format");
    if (!token || lease.token !== token) throw new Error("lease token does not match");
    await fs.rm(filename, { force: true });
    return true;
  }

  async withdrawRequest(id) {
    const filename = fileFor(this.requestsDir, id);
    try {
      await fs.rm(filename);
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }

  async resourceState(resource = "demo-resource") {
    await this.init();
    const filename = fileFor(this.resourcesDir, encodeURIComponent(resource));
    const state = await this.#readJson(filename);
    return state || {
      formatVersion: FORMAT_VERSION,
      resource,
      applied: [],
      builtBy: null,
      updatedAt: null,
    };
  }

  async setResourceState({ resource = "demo-resource", applied = [], builtBy = "manual demo setup" }) {
    await this.init();
    const state = {
      formatVersion: FORMAT_VERSION,
      resource,
      applied: [...new Set(applied)].sort().map((name) => ({ name, appliedAt: this.now() })),
      builtBy,
      updatedAt: this.now(),
    };
    await this.#writeJson(fileFor(this.resourcesDir, encodeURIComponent(resource)), state);
    return state;
  }

  async preflight({ resource = "demo-resource", expected = [] }) {
    const state = await this.resourceState(resource);
    const actual = state.applied.map((item) => typeof item === "string" ? item : item.name).filter(Boolean).sort();
    const wanted = [...new Set(expected)].filter(Boolean).sort();
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
    const leases = await this.listLeases();
    const requests = await this.listRequests();
    const resources = {};
    const resourceFiles = await fs.readdir(this.resourcesDir);
    for (const filename of resourceFiles.filter((name) => name.endsWith(".json"))) {
      const state = await this.#readJson(path.join(this.resourcesDir, filename));
      if (state?.resource) resources[state.resource] = state;
    }
    for (const lease of leases) resources[lease.resource] = await this.resourceState(lease.resource);
    for (const request of requests) {
      if (request.resource !== "unknown" && !resources[request.resource]) resources[request.resource] = await this.resourceState(request.resource);
    }
    return { stateDir: this.stateDir, resources, leases, requests };
  }

  async #readJson(filename) {
    try {
      return JSON.parse(await fs.readFile(filename, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async #writeJson(filename, value) {
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(temporary, filename);
  }
}

function defaultIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
