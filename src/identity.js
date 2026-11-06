import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";

// Holder liveness for one Linux or macOS host.
// "dead" is returned only when this host can prove the recorded process is gone.
// A failed probe is "unknown" and must be treated as still held.

const PROBE_ENV = { ...process.env, LC_ALL: "C", LANG: "C" };

function readTrim(filename) {
  try {
    const text = readFileSync(filename, "utf8").trim();
    return text || null;
  } catch {
    return null;
  }
}

function runProbe(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      timeout: 3000,
      env: PROBE_ENV,
    });
  } catch {
    return null;
  }
}

export function parseIOPlatformUUID(text) {
  if (typeof text !== "string") return null;
  const match = text.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
  return match?.[1] || null;
}

export function parseBootTime(text) {
  if (typeof text !== "string") return null;
  const match = text.match(/\{[^}]+\}/);
  const value = (match ? match[0] : text).trim();
  return value || null;
}

export function readPidNamespace(pid) {
  if (process.platform !== "linux") return null;
  try {
    return readlinkSync(`/proc/${pid}/ns/pid`);
  } catch {
    return null;
  }
}

export function readStartTicks(pid) {
  if (process.platform !== "linux") return null;
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = text.lastIndexOf(")");
    if (end < 0) return null;
    const fields = text.slice(end + 2).trim().split(/\s+/);
    const ticks = Number(fields[19]);
    return Number.isInteger(ticks) && ticks >= 0 ? ticks : null;
  } catch {
    return null;
  }
}

function readDarwinMachineId() {
  return parseIOPlatformUUID(runProbe("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]));
}

function readDarwinBootId() {
  return parseBootTime(runProbe("sysctl", ["-n", "kern.boottime"]));
}

function readDarwinStart(pid) {
  const text = runProbe("ps", ["-o", "lstart=", "-p", String(pid)]);
  const value = text?.trim() || "";
  return value || null;
}

export function readStartId(pid) {
  if (process.platform === "darwin") return readDarwinStart(pid);
  if (process.platform === "linux") {
    const ticks = readStartTicks(pid);
    return Number.isInteger(ticks) ? String(ticks) : null;
  }
  return null;
}

let cachedLocal;

export function localIdentity() {
  if (!cachedLocal) {
    if (process.platform === "darwin") {
      cachedLocal = {
        platform: "darwin",
        machineId: readDarwinMachineId(),
        bootId: readDarwinBootId(),
        pidNamespace: null,
      };
    } else if (process.platform === "linux") {
      cachedLocal = {
        platform: "linux",
        machineId: readTrim("/etc/machine-id"),
        bootId: readTrim("/proc/sys/kernel/random/boot_id"),
        pidNamespace: readPidNamespace("self"),
      };
    } else {
      cachedLocal = {
        platform: process.platform,
        machineId: null,
        bootId: null,
        pidNamespace: null,
      };
    }
  }
  return cachedLocal;
}

export function currentProcessIdentity(pid = process.pid) {
  const local = localIdentity();
  const startId = readStartId(pid);
  const identity = {
    pid,
    platform: local.platform,
    machineId: local.machineId,
    bootId: local.bootId,
    pidNamespace: local.platform === "linux" ? readPidNamespace(pid) : null,
    startId,
  };
  if (local.platform === "linux" && typeof startId === "string" && /^\d+$/.test(startId)) {
    identity.startTicks = Number(startId);
  }
  return identity;
}

export function probeProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { code: "EINVAL", startId: null };
  try {
    process.kill(pid, 0);
  } catch (error) {
    return { code: error.code || "UNKNOWN", startId: null };
  }
  return { code: null, startId: readStartId(pid) };
}

export function decideLiveness(identity, local, probe) {
  if (!identity || !Number.isInteger(identity.pid) || identity.pid <= 0) return "unknown";
  if (identity.platform && local?.platform && identity.platform !== local.platform) return "unknown";
  const machineKnown = Boolean(identity.machineId && local?.machineId);
  const sameMachine = machineKnown && identity.machineId === local.machineId;
  if (machineKnown && !sameMachine) return "unknown";
  const bootDiffers = Boolean(sameMachine && identity.bootId && local?.bootId && identity.bootId !== local.bootId);
  if (bootDiffers) return "dead";
  const linuxRecord = identity.platform === "linux" || local?.platform === "linux";
  if (linuxRecord && (!identity.pidNamespace || !local?.pidNamespace)) return "unknown";
  if (identity.pidNamespace && local?.pidNamespace && identity.pidNamespace !== local.pidNamespace) return "unknown";

  const code = probe?.code === undefined ? "UNKNOWN" : probe.code;
  if (code === "ESRCH") {
    if (!sameMachine || !identity.bootId || !local?.bootId) return "unknown";
    return "dead";
  }
  if (code !== null && code !== "EPERM") return "unknown";
  const recorded = typeof identity.startId === "string" && identity.startId ? identity.startId : null;
  const probed = typeof probe?.startId === "string" && probe.startId ? probe.startId : null;
  if (!recorded || !probed) return "unknown";
  if (recorded !== probed) return "dead";
  return "alive";
}
