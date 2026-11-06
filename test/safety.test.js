import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LeaseStore, LeaseUnavailable, LeaseUncertain } from "../src/leases.js";
import { currentProcessIdentity } from "../src/identity.js";
import { removeStore, tempStore, testEnv } from "../support/helpers.js";

const resource = "demo-resource";
const other = "other-resource";

async function plant(store, name, contents) {
  await store.init();
  const filename = path.join(store.leasesDir, name);
  await writeFile(filename, typeof contents === "string" ? contents : `${JSON.stringify(contents, null, 2)}\n`);
  return filename;
}

test("corrupt, unknown-version, and invalid holder records block and are kept", async () => {
  const store = await tempStore();
  try {
    const future = "11111111-1111-4111-8111-111111111111";
    const futureFile = await plant(store, `${future}.json`, {
      formatVersion: 1,
      id: future,
      resource,
      kind: "write",
      pid: process.pid,
      purpose: "old",
    });
    await assert.rejects(
      () => store.acquire({ kind: "write", purpose: "next", resource }),
      (error) => error instanceof LeaseUncertain,
    );
    assert.equal(await readFile(futureFile, "utf8").then(() => true), true);
    const elsewhere = await store.acquire({ kind: "write", purpose: "other", resource: other });
    await store.release(elsewhere.id, elsewhere.token);

    const corrupt = "22222222-2222-4222-8222-222222222222";
    const corruptFile = await plant(store, `${corrupt}.json`, "{ this is not json");
    await assert.rejects(
      () => store.acquire({ kind: "write", purpose: "blocked", resource: other }),
      (error) => error instanceof LeaseUncertain,
    );
    assert.equal(await readFile(corruptFile, "utf8").then(() => true), true);

    const held = await new LeaseStore({ stateDir: store.stateDir, isAlive: () => true }).acquire({
      kind: "read",
      purpose: "shaped",
      resource: "third-resource",
    }).catch(() => null);
    assert.equal(held, null);
  } finally {
    await removeStore(store);
  }
});

test("a disappearing lease file is not treated as corruption", async () => {
  let target = null;
  const store = await tempStore({
    testHooks: {
      onLeaseFilename: async (filename) => {
        if (target && filename === target) await rm(filename, { force: true });
      },
    },
  });
  try {
    const first = await store.acquire({ kind: "write", purpose: "first", resource });
    target = path.join(store.leasesDir, `${first.id}.json`);
    const second = await store.acquire({ kind: "write", purpose: "second", resource });
    assert.notEqual(second.id, first.id);
    assert.equal(second.kind, "write");
    await store.release(second.id, second.token);
  } finally {
    await removeStore(store);
  }
});

test("invalid lease shape is kept and blocks that resource", async () => {
  const store = await tempStore();
  try {
    const lease = await store.acquire({ kind: "write", purpose: "holder", resource });
    const filename = path.join(store.leasesDir, `${lease.id}.json`);
    const body = JSON.parse(await readFile(filename, "utf8"));
    body.kind = "sideways";
    await writeFile(filename, JSON.stringify(body));
    await assert.rejects(
      () => store.acquire({ kind: "write", purpose: "next", resource }),
      (error) => error instanceof LeaseUncertain,
    );
    assert.equal(JSON.parse(await readFile(filename, "utf8")).kind, "sideways");
    const otherLease = await store.acquire({ kind: "read", purpose: "unaffected", resource: other });
    await store.release(otherLease.id, otherLease.token);
  } finally {
    await removeStore(store);
  }
});

test("unknown liveness blocks destructive acquire and status does not delete", async () => {
  const store = await tempStore();
  try {
    const lease = await store.acquire({ kind: "read", purpose: "held", resource });
    const filename = path.join(store.leasesDir, `${lease.id}.json`);
    const blind = new LeaseStore({ stateDir: store.stateDir, isAlive: () => "unknown" });
    await blind.status();
    assert.equal(await readFile(filename, "utf8").then(() => true), true);
    await assert.rejects(
      () => blind.acquire({ kind: "write", purpose: "next", resource }),
      (error) => error instanceof LeaseUnavailable,
    );
    assert.equal(await readFile(filename, "utf8").then(() => true), true);

    const deadView = new LeaseStore({ stateDir: store.stateDir, isAlive: () => false });
    await deadView.status();
    assert.equal(await readFile(filename, "utf8").then(() => true), true);
    const replacement = await deadView.acquire({ kind: "write", purpose: "after-death", resource });
    await assert.rejects(() => readFile(filename, "utf8"), (error) => error.code === "ENOENT");
    await deadView.release(replacement.id, replacement.token);
  } finally {
    await removeStore(store);
  }
});

test("process identity distinguishes reboot, reuse, and foreign hosts", async () => {
  const store = await tempStore();
  try {
    const lease = await store.acquire({ kind: "write", purpose: "holder", resource });
    const filename = path.join(store.leasesDir, `${lease.id}.json`);
    const original = JSON.parse(await readFile(filename, "utf8"));

    original.identity.startTicks += 1;
    await writeFile(filename, JSON.stringify(original));
    const afterReuse = await store.acquire({ kind: "write", purpose: "reused", resource });
    await assert.rejects(() => readFile(filename, "utf8"), (error) => error.code === "ENOENT");
    await store.release(afterReuse.id, afterReuse.token);

    const foreign = await store.acquire({ kind: "write", purpose: "foreign", resource });
    const foreignFile = path.join(store.leasesDir, `${foreign.id}.json`);
    const foreignBody = JSON.parse(await readFile(foreignFile, "utf8"));
    foreignBody.identity.machineId = "not-this-machine";
    await writeFile(foreignFile, JSON.stringify(foreignBody));
    await assert.rejects(
      () => store.acquire({ kind: "write", purpose: "intruder", resource }),
      (error) => error instanceof LeaseUnavailable,
    );
    assert.equal(await readFile(foreignFile, "utf8").then(() => true), true);
    assert.equal(await store.release(foreign.id, foreign.token), true);

    const namespaced = await store.acquire({ kind: "read", purpose: "namespace", resource });
    const namespaceFile = path.join(store.leasesDir, `${namespaced.id}.json`);
    const namespaceBody = JSON.parse(await readFile(namespaceFile, "utf8"));
    namespaceBody.identity.pidNamespace = namespaceBody.identity.pidNamespace === "pid:[1]" ? "pid:[2]" : "pid:[1]";
    await writeFile(namespaceFile, JSON.stringify(namespaceBody));
    await assert.rejects(
      () => store.acquire({ kind: "write", purpose: "intruder", resource }),
      (error) => error instanceof LeaseUnavailable,
    );
    assert.equal(await readFile(namespaceFile, "utf8").then(() => true), true);
    assert.equal(await store.release(namespaced.id, namespaced.token), true);

    const rebooted = await store.acquire({ kind: "read", purpose: "reboot", resource });
    const rebootFile = path.join(store.leasesDir, `${rebooted.id}.json`);
    const rebootBody = JSON.parse(await readFile(rebootFile, "utf8"));
    rebootBody.identity.bootId = "not-the-current-boot";
    await writeFile(rebootFile, JSON.stringify(rebootBody));
    const afterBoot = await store.acquire({ kind: "write", purpose: "after-boot", resource });
    await assert.rejects(() => readFile(rebootFile, "utf8"), (error) => error.code === "ENOENT");
    await store.release(afterBoot.id, afterBoot.token);
  } finally {
    await removeStore(store);
  }
});

test("ids cannot escape the record directory or follow a symlink", async () => {
  const store = await tempStore();
  try {
    await store.init();
    const sibling = path.join(store.stateDir, "sibling");
    await mkdir(sibling);
    const victim = path.join(sibling, "note.json");
    await writeFile(victim, "{\"keep\":true}\n");
    await assert.rejects(() => store.withdrawRequest("../sibling/note", "token"));
    await assert.rejects(() => store.withdrawRequest(`${victim.slice(0, -5)}`, "token"));
    await assert.rejects(() => store.release("../sibling/note", "token"));
    assert.equal(await readFile(victim, "utf8"), "{\"keep\":true}\n");

    const outside = path.join(store.stateDir, "outside.json");
    await writeFile(outside, "{\"keep\":true}\n");
    const id = "33333333-3333-4333-8333-333333333333";
    const link = path.join(store.leasesDir, `${id}.json`);
    await symlink(outside, link);
    await assert.rejects(
      () => store.acquire({ kind: "read", purpose: "blocked", resource: other }),
      (error) => error instanceof LeaseUncertain,
    );
    assert.equal(await readFile(outside, "utf8"), "{\"keep\":true}\n");
    assert.equal((await lstat(link)).isSymbolicLink(), true);
  } finally {
    await removeStore(store);
  }
});

test("preflight reports unknown for a damaged record and none when the record is absent", async () => {
  const store = await tempStore();
  try {
    assert.equal((await store.preflight({ resource, expected: [] })).outcome, "none");
    assert.equal((await store.preflight({ resource, expected: ["001-base"] })).outcome, "none");
    await store.init();
    await writeFile(path.join(store.resourcesDir, `${encodeURIComponent(resource)}.json`), JSON.stringify({
      resource,
      applied: "nope",
    }));
    const result = await store.preflight({ resource, expected: ["001-base"] });
    assert.equal(result.outcome, "unknown");
    assert.match(result.reason, /applied|format|object/i);
  } finally {
    await removeStore(store);
  }
});

test("a past estimate and an interruptible reader still block a writer", async () => {
  const store = await tempStore();
  try {
    const reader = await store.acquire({
      kind: "read",
      purpose: "suite",
      resource,
      expectedUntil: "2000-01-01T00:00:00.000Z",
      interruptible: true,
    });
    await assert.rejects(
      () => store.acquire({ kind: "write", purpose: "change", resource }),
      (error) => error instanceof LeaseUnavailable && error.reason === "readers-active",
    );
    await store.release(reader.id, reader.token);
  } finally {
    await removeStore(store);
  }
});

test("flat resource names do not consult a dependency graph", async () => {
  const store = await tempStore();
  try {
    const reader = await store.acquire({ kind: "read", purpose: "db suite", resource: "db:project" });
    const writer = await store.acquire({ kind: "write", purpose: "restart runtime", resource: "docker" });
    assert.equal(writer.resource, "docker");
    await store.release(writer.id, writer.token);
    await store.release(reader.id, reader.token);
  } finally {
    await removeStore(store);
  }
});

test("requests are durable proposals and not a grant queue", async () => {
  const store = await tempStore();
  try {
    const reader = await store.acquire({ kind: "read", purpose: "suite", resource });
    let first;
    try {
      await store.acquire({ kind: "write", purpose: "first writer", resource });
    } catch (error) {
      first = error.request;
    }
    await store.release(reader.id, reader.token);
    const second = await store.acquire({ kind: "write", purpose: "second writer", resource });
    assert.equal(second.kind, "write");
    assert.equal((await store.listRequests()).some((request) => request.id === first.id), true);
    await store.release(second.id, second.token);
  } finally {
    await removeStore(store);
  }
});

test("mutating the demo record requires a live write lease", async () => {
  const store = await tempStore();
  try {
    await assert.rejects(() => store.setResourceState({ resource, applied: ["001-base"] }), /write lease/);
    const reader = await store.acquire({ kind: "read", purpose: "reader", resource });
    await assert.rejects(
      () => store.setResourceState({ resource, applied: ["001-base"], leaseId: reader.id, token: reader.token }),
      /write lease/,
    );
    await store.release(reader.id, reader.token);
    const writer = await store.acquire({ kind: "write", purpose: "writer", resource });
    const state = await store.setResourceState({
      resource,
      applied: ["001-base"],
      builtBy: "holder",
      leaseId: writer.id,
      token: writer.token,
    });
    assert.equal(state.applied[0].name, "001-base");
    assert.equal(state.builtBy, "holder");
    await store.release(writer.id, writer.token);
    await assert.rejects(
      () => store.setResourceState({ resource, applied: ["002-next"], leaseId: writer.id, token: writer.token }),
      /write lease/,
    );
    await store.seedResourceState({ resource, applied: ["002-next"], builtBy: "fixture" });
    assert.equal((await store.resourceState(resource)).builtBy, "fixture");
  } finally {
    await removeStore(store);
  }
});

test("an urgent request requires a message and bad input is rejected", async () => {
  const store = await tempStore();
  try {
    await assert.rejects(
      () => store.acquire({ kind: "write", purpose: "change", resource, urgency: "urgent" }),
      /message/,
    );
    await assert.rejects(
      () => store.acquire({ kind: "read", purpose: true, resource }),
      /purpose/,
    );
    await assert.rejects(() => store.acquire({ kind: "read", purpose: "ok", resource: "../etc" }), /resource/);
  } finally {
    await removeStore(store);
  }
});

test("store directories and records are private even with a permissive umask", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-leases-mode-"));
  const moduleUrl = pathToFileURL(path.join(process.cwd(), "src/leases.js")).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    process.umask(0);
    const { LeaseStore } = await import(${JSON.stringify(moduleUrl)});
    const store = new LeaseStore();
    const lease = await store.acquire({ kind: "read", purpose: "mode", resource: "demo-resource" });
    console.log(lease.id);
  `], {
    stdio: ["ignore", "pipe", "pipe"],
    env: testEnv({ AGENT_LEASES_STATE_DIR: directory }),
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  try {
    assert.equal(code, 0, stderr);
    const id = stdout.trim();
    assert.equal((await lstat(path.join(directory, "leases"))).mode & 0o777, 0o700);
    assert.equal((await lstat(path.join(directory, "leases", `${id}.json`))).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a symlinked state directory is refused", async () => {
  const real = await import("node:fs/promises").then((fs) => fs.mkdtemp(path.join(os.tmpdir(), "agent-leases-real-")));
  const link = `${real}-link`;
  await symlink(real, link);
  try {
    const store = new LeaseStore({ stateDir: link });
    await assert.rejects(() => store.init(), /symlink/);
  } finally {
    await rm(link, { force: true });
    await rm(real, { recursive: true, force: true });
  }
});

test("a dead lock is recovered and an unconfirmed lock is not stolen", async () => {
  const store = await tempStore();
  try {
    await store.init();
    const lockPath = path.join(store.stateDir, "lock");
    const dead = { ...currentProcessIdentity(), pid: 2147483646, token: "44444444-4444-4444-8444-444444444444" };
    await writeFile(lockPath, JSON.stringify(dead));
    const recovered = await store.acquire({ kind: "read", purpose: "after stale lock", resource });
    assert.equal(recovered.kind, "read");
    await store.release(recovered.id, recovered.token);

    const live = { ...currentProcessIdentity(), token: "55555555-5555-4555-8555-555555555555" };
    await writeFile(lockPath, JSON.stringify(live));
    const busy = new LeaseStore({ stateDir: store.stateDir, lockWaitMs: 200 });
    await assert.rejects(
      () => busy.acquire({ kind: "read", purpose: "waiting", resource }),
      (error) => error instanceof LeaseUnavailable && error.reason === "lock-timeout",
    );
    assert.equal(await readFile(lockPath, "utf8").then((text) => JSON.parse(text).token), live.token);
    await rm(lockPath);

    await writeFile(lockPath, "");
    const old = new Date(Date.now() - 10_000);
    await utimes(lockPath, old, old);
    const patient = new LeaseStore({ stateDir: store.stateDir, lockPublishGraceMs: 1_000 });
    const afterEmpty = await patient.acquire({ kind: "read", purpose: "after empty lock", resource });
    await patient.release(afterEmpty.id, afterEmpty.token);

    await writeFile(lockPath, "");
    const cautious = new LeaseStore({ stateDir: store.stateDir, lockWaitMs: 200, lockPublishGraceMs: 60_000 });
    await assert.rejects(
      () => cautious.acquire({ kind: "read", purpose: "fresh empty lock", resource }),
      (error) => error instanceof LeaseUncertain,
    );
  } finally {
    await removeStore(store);
  }
});
