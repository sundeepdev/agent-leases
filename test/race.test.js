import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LeaseStore } from "../src/leases.js";
import { testEnv } from "../support/helpers.js";

const helper = fileURLToPath(new URL("../support/spawn-acquire.js", import.meta.url));
const resource = "demo-resource";

async function newStore() {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "agent-leases-race-"));
  return new LeaseStore({ stateDir });
}

test("concurrent conflicting acquires in one process grant only one holder", async () => {
  for (let trial = 0; trial < 20; trial += 1) {
    const store = await newStore();
    try {
      const results = await Promise.allSettled([
        store.acquire({ kind: "write", purpose: "A", resource }),
        store.acquire({ kind: "write", purpose: "B", resource }),
      ]);
      const granted = results.filter((result) => result.status === "fulfilled");
      assert.equal(granted.length, 1, `write/write trial ${trial} granted ${granted.length}`);
    } finally {
      await rm(store.stateDir, { recursive: true, force: true });
    }
  }
  for (let trial = 0; trial < 10; trial += 1) {
    const store = await newStore();
    try {
      const results = await Promise.allSettled([
        store.acquire({ kind: "read", purpose: "reader", resource }),
        store.acquire({ kind: "write", purpose: "writer", resource }),
      ]);
      const granted = results.filter((result) => result.status === "fulfilled");
      assert.equal(granted.length, 1, `read/write trial ${trial} granted ${granted.length}`);
    } finally {
      await rm(store.stateDir, { recursive: true, force: true });
    }
  }
});

test("two real processes cannot both acquire conflicting leases", { timeout: 60_000 }, async () => {
  // Measured on 481a577 before the store lock: 40/40 in-process double grants,
  // 11/20 multi-process double grants on an empty directory, and 15/15 when
  // the directory already held other leases. This test fails if that race returns.
  await runProcessPairs({ kinds: ["write", "write"], trials: 6, noise: 8 });
  await runProcessPairs({ kinds: ["read", "write"], trials: 4, noise: 8 });
});

async function runProcessPairs({ kinds, trials, noise }) {
  for (let trial = 0; trial < trials; trial += 1) {
    const store = await newStore();
    const children = [];
    try {
      for (let index = 0; index < noise; index += 1) {
        await store.acquire({ kind: "read", purpose: `noise ${index}`, resource: "noise-resource" });
      }
      const goFile = path.join(store.stateDir, "go");
      const pending = kinds.map((kind, index) => launch(store.stateDir, kind, `P${index}`, goFile));
      children.push(...pending.map((entry) => entry.child));
      await new Promise((resolve) => setTimeout(resolve, 40));
      await writeFile(goFile, "go");
      const results = await Promise.all(pending.map((entry) => entry.result));
      const granted = results.filter((result) => result.ok);
      assert.equal(
        granted.length,
        1,
        `${kinds.join("/")} trial ${trial} granted ${granted.length}: ${JSON.stringify(results)}`,
      );
    } finally {
      for (const child of children) {
        try { child.kill("SIGKILL"); } catch { /* already exited */ }
      }
      await Promise.all(children.map((child) => {
        if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
        return new Promise((resolve) => child.once("exit", resolve));
      }));
      await rm(store.stateDir, { recursive: true, force: true });
    }
  }
}

function launch(stateDir, kind, purpose, goFile) {
  const resultFile = path.join(stateDir, `result-${purpose}.json`);
  const child = spawn(process.execPath, [helper, stateDir, kind, purpose, resource, goFile, resultFile], {
    stdio: "ignore",
    env: testEnv(),
  });
  const result = readResult(resultFile);
  return { child, result };
}

async function readResult(resultFile) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(resultFile, "utf8"));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
  return { ok: false, message: "timed out waiting for process result" };
}
