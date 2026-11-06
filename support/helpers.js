import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LeaseStore } from "../src/leases.js";

export async function tempStore(options = {}) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "agent-leases-"));
  return new LeaseStore({ stateDir, ...options });
}

export async function removeStore(store) {
  if (store?.stateDir) await rm(store.stateDir, { recursive: true, force: true });
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// node --test exposes an IPC channel through the environment. A child Node
// process that inherits it attaches to the test runner and can cancel the file.
export function testEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_CHANNEL_FD;
  delete env.NODE_TEST_CONTEXT;
  return env;
}
