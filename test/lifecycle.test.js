import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LeaseStore, LeaseUnavailable } from "../src/leases.js";
import { delay, testEnv } from "../support/helpers.js";

const cli = path.join(process.cwd(), "src/cli.js");
const resource = "demo-resource";

async function newDir() {
  return mkdtemp(path.join(os.tmpdir(), "agent-leases-life-"));
}

function spawnCli(args) {
  const child = spawn(process.execPath, [cli, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: testEnv(),
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return { child, exited, output: () => ({ stdout, stderr }) };
}

async function waitForLease(stateDir, predicate, timeout = 5_000) {
  const directory = path.join(stateDir, "leases");
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const names = await readdir(directory).catch(() => []);
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const lease = JSON.parse(await readFile(path.join(directory, name), "utf8"));
        if (!predicate || predicate(lease)) return lease;
      } catch {
        // The file may be renamed into place between readdir and read.
      }
    }
    await delay(20);
  }
  throw new Error("timed out waiting for a lease");
}

async function waitDead(pid) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
    }
    await delay(20);
  }
  throw new Error(`pid ${pid} is still alive`);
}

test("withLease holds the resource until the operation finishes", async () => {
  const stateDir = await newDir();
  const store = new LeaseStore({ stateDir });
  try {
    let releaseGate;
    const gate = new Promise((resolve) => { releaseGate = resolve; });
    const running = store.withLease({ kind: "write", purpose: "migration", resource }, async () => {
      await gate;
      return "done";
    });
    await waitForLease(stateDir);
    await assert.rejects(
      () => store.acquire({ kind: "write", purpose: "other", resource }),
      (error) => error instanceof LeaseUnavailable,
    );
    releaseGate();
    assert.equal(await running, "done");
    assert.equal((await store.listLeases()).length, 0);

    await assert.rejects(
      () => store.withLease({ kind: "read", purpose: "fails", resource }, async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal((await store.listLeases()).length, 0);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("run keeps the lease until the child exits and then releases it", async () => {
  const stateDir = await newDir();
  try {
    const finished = spawnCli([
      "run", "--kind", "read", "--purpose", "job", "--state-dir", stateDir, "--",
      process.execPath, "-e", "process.exit(4)",
    ]);
    const outcome = await finished.exited;
    assert.equal(outcome.code, 4, finished.output().stderr);
    const names = await readdir(path.join(stateDir, "leases"));
    assert.equal(names.filter((name) => name.endsWith(".json")).length, 0);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a conflicting acquire is refused while run is supervising a child", async () => {
  const stateDir = await newDir();
  const running = spawnCli([
    "run", "--kind", "write", "--purpose", "held", "--state-dir", stateDir, "--",
    process.execPath, "-e", "setInterval(() => {}, 1000)",
  ]);
  try {
    await waitForLease(stateDir, (lease) => lease.supervisor);
    const refused = spawnCli([
      "acquire", "--kind", "write", "--purpose", "intruder", "--state-dir", stateDir,
    ]);
    const outcome = await refused.exited;
    assert.equal(outcome.code, 75, refused.output().stderr);
    process.kill(running.child.pid, "SIGTERM");
    const stopped = await running.exited;
    assert.equal(stopped.code, 143);
    const names = await readdir(path.join(stateDir, "leases"));
    assert.equal(names.filter((name) => name.endsWith(".json")).length, 0);
    const store = new LeaseStore({ stateDir });
    const next = await store.acquire({ kind: "write", purpose: "after", resource });
    await store.release(next.id, next.token);
  } finally {
    try { process.kill(running.child.pid, "SIGKILL"); } catch { /* already exited */ }
    await running.exited;
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a supervised child keeps the lease if the supervisor is killed", { timeout: 20_000 }, async () => {
  const stateDir = await newDir();
  const running = spawnCli([
    "run", "--kind", "write", "--purpose", "held", "--state-dir", stateDir, "--",
    process.execPath, "-e", "setInterval(() => {}, 1000)",
  ]);
  let workerPid;
  try {
    const lease = await waitForLease(stateDir, (record) => record.supervisor);
    workerPid = lease.pid;
    assert.notEqual(workerPid, running.child.pid);
    process.kill(running.child.pid, "SIGKILL");
    await running.exited;
    assert.doesNotThrow(() => process.kill(workerPid, 0));
    const store = new LeaseStore({ stateDir });
    await assert.rejects(
      () => store.acquire({ kind: "write", purpose: "intruder", resource }),
      (error) => error instanceof LeaseUnavailable,
    );
    process.kill(workerPid, "SIGKILL");
    await waitDead(workerPid);
    const next = await store.acquire({ kind: "write", purpose: "after", resource });
    assert.equal(next.kind, "write");
    await store.release(next.id, next.token);
  } finally {
    try { process.kill(running.child.pid, "SIGKILL"); } catch { /* already exited */ }
    if (workerPid) {
      try { process.kill(workerPid, "SIGKILL"); } catch { /* already exited */ }
    }
    await running.exited;
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("acquire without hold does not cover a later process", async () => {
  const stateDir = await newDir();
  try {
    const first = spawnCli(["acquire", "--kind", "write", "--purpose", "one", "--state-dir", stateDir]);
    const firstExit = await first.exited;
    assert.equal(firstExit.code, 0, first.output().stderr);
    assert.match(first.output().stderr, /does not cover later work/);
    const second = spawnCli(["acquire", "--kind", "write", "--purpose", "two", "--state-dir", stateDir]);
    const secondExit = await second.exited;
    assert.equal(secondExit.code, 0, second.output().stderr);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("--hold releases the lease when the process is signalled", async () => {
  const stateDir = await newDir();
  const running = spawnCli([
    "acquire", "--kind", "write", "--purpose", "held", "--hold", "--state-dir", stateDir,
  ]);
  try {
    const announced = Date.now() + 5_000;
    while (Date.now() < announced && !running.output().stderr.includes("Holding")) {
      await delay(15);
    }
    process.kill(running.child.pid, "SIGTERM");
    const outcome = await running.exited;
    assert.equal(outcome.code, 0);
    const names = await readdir(path.join(stateDir, "leases"));
    assert.equal(names.filter((name) => name.endsWith(".json")).length, 0);
  } finally {
    try { process.kill(running.child.pid, "SIGKILL"); } catch { /* already exited */ }
    await running.exited;
    await rm(stateDir, { recursive: true, force: true });
  }
});
