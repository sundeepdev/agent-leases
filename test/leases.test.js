import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LeaseStore, LeaseUnavailable, REFUSED_EXIT_CODE } from "../src/leases.js";

async function newStore() {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "agent-leases-"));
  return new LeaseStore({ stateDir, isAlive: () => true });
}

const reader = (store, purpose) => store.acquire({
  kind: "read",
  purpose,
  resource: "shared-demo",
  pid: process.pid,
});

test("two concurrent readers coexist", async () => {
  const store = await newStore();
  const first = await reader(store, "test suite A");
  const second = await reader(store, "test suite B");

  assert.equal((await store.listLeases()).length, 2);
  assert.deepEqual((await store.listLeases()).map((lease) => lease.purpose).sort(), ["test suite A", "test suite B"]);
  await store.release(first.id, first.token);
  await store.release(second.id, second.token);
});

test("a writer consults readers, posts a request, and can proceed after release", async () => {
  const store = await newStore();
  const activeReader = await reader(store, "long-running tests");

  await assert.rejects(
    () => store.acquire({ kind: "write", purpose: "apply change", resource: "shared-demo", operation: "update demo state" }),
    (error) => {
      assert.ok(error instanceof LeaseUnavailable);
      assert.equal(error.code, "LEASE_UNAVAILABLE");
      assert.equal(error.holders[0].id, activeReader.id);
      assert.equal(error.request.message, "Requesting permission to update demo state");
      return true;
    },
  );
  assert.equal((await store.listRequests()).length, 1);

  await store.release(activeReader.id, activeReader.token);
  const writer = await store.acquire({ kind: "write", purpose: "apply change", resource: "shared-demo" });
  assert.equal(writer.kind, "write");
  await store.release(writer.id, writer.token);
});

test("status reports holders and resource state, and withdraw removes a request", async () => {
  const store = await newStore();
  await store.setResourceState({ resource: "shared-demo", applied: ["base"], builtBy: "branch/demo" });
  const activeReader = await reader(store, "local server");
  let request;
  try {
    await store.acquire({ kind: "write", purpose: "migration", resource: "shared-demo" });
  } catch (error) {
    request = error.request;
  }
  const status = await store.status();
  assert.equal(status.leases[0].purpose, "local server");
  assert.equal(status.resources["shared-demo"].builtBy, "branch/demo");
  assert.equal(status.requests[0].id, request.id);
  assert.equal(await store.withdrawRequest(request.id), true);
  await store.release(activeReader.id, activeReader.token);
});

test("preflight compares expected local state with actual resource state", async () => {
  const store = await newStore();
  await store.setResourceState({ resource: "shared-demo", applied: ["001-base", "002-other"], builtBy: "branch/other" });

  const result = await store.preflight({ resource: "shared-demo", expected: ["001-base", "003-mine"] });
  assert.equal(result.outcome, "behind+ahead");
  assert.deepEqual(result.missing, ["003-mine"]);
  assert.deepEqual(result.extra, ["002-other"]);

  await store.setResourceState({ resource: "shared-demo", applied: ["001-base", "003-mine"] });
  assert.equal((await store.preflight({ resource: "shared-demo", expected: ["001-base", "003-mine"] })).outcome, "match");
});

// Keep the public exit-code contract close to the behavior it describes.
test("refused modifiers use the documented exit code", () => {
  assert.equal(REFUSED_EXIT_CODE, 75);
});
