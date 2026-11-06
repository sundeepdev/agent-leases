import { readFileSync, readlinkSync } from "node:fs";

// Holder liveness for one Linux host and one PID namespace.
// "dead" is returned only when this host can prove the recorded process is gone.
// Anything less certain is "unknown" and must be treated as still held.

function readTrim(filename) {
  try {
    const text = readFileSync(filename, "utf8").trim();
    return text || null;
  } catch {
    return null;
  }
}

export function readPidNamespace(pid) {
  try {
    return readlinkSync(`/proc/${pid}/ns/pid`);
  } catch {
    return null;
  }
}

export function readStartTicks(pid) {
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

let cachedLocal;

export function localIdentity() {
  if (!cachedLocal) {
    cachedLocal = {
      machineId: readTrim("/etc/machine-id"),
      bootId: readTrim("/proc/sys/kernel/random/boot_id"),
      pidNamespace: readPidNamespace("self"),
    };
  }
  return cachedLocal;
}

export function currentProcessIdentity(pid = process.pid) {
  const local = localIdentity();
  return {
    pid,
    machineId: local.machineId,
    bootId: local.bootId,
    pidNamespace: readPidNamespace(pid),
    startTicks: readStartTicks(pid),
  };
}

export function probeProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { code: "EINVAL", startTicks: null };
  try {
    process.kill(pid, 0);
  } catch (error) {
    return { code: error.code || "UNKNOWN", startTicks: null };
  }
  return { code: null, startTicks: readStartTicks(pid) };
}

export function decideLiveness(identity, local, probe) {
  if (!identity || !Number.isInteger(identity.pid) || identity.pid <= 0) return "unknown";
  const machineKnown = Boolean(identity.machineId && local?.machineId);
  const sameMachine = machineKnown && identity.machineId === local.machineId;
  if (machineKnown && !sameMachine) return "unknown";
  const bootDiffers = Boolean(sameMachine && identity.bootId && local.bootId && identity.bootId !== local.bootId);
  if (bootDiffers) return "dead";
  const namespaceDiffers = Boolean(
    sameMachine && identity.pidNamespace && local.pidNamespace && identity.pidNamespace !== local.pidNamespace,
  );
  if (namespaceDiffers) return "unknown";

  const code = probe?.code === undefined ? "UNKNOWN" : probe.code;
  if (code === "EPERM") return "alive";
  if (code === "ESRCH") {
    if (!sameMachine || !identity.bootId || !local?.bootId || !identity.pidNamespace || !local?.pidNamespace) {
      return "unknown";
    }
    return "dead";
  }
  if (code !== null) return "unknown";
  if (!Number.isInteger(identity.startTicks) || !Number.isInteger(probe?.startTicks)) return "alive";
  if (identity.startTicks !== probe.startTicks) return "dead";
  return "alive";
}
