import test from "node:test";
import assert from "node:assert/strict";
import { LeaseStore, LeaseUnavailable, REFUSED_EXIT_CODE, FORMAT_VERSION } from "../src/leases.js";
import { removeStore, tempStore } from "../support/helpers.js";

const reader = (store, purpose) => store.acquire({
  kind: "read",
  purpose,
  resource: "shared-demo",
});

test("two concurrent readers coexist", async () => {
  const store = await tempStore();
  try {
    const [first, second] = await Promise.all([
      reader(store, "test suite A"),
      reader(store, "test suite B"),
    ]);
    assert.equal((await store.listLeases()).length, 2);
    assert.deepEqual((await store.listLeases()).map((lease) => lease.purpose).sort(), ["test suite A", "test suite B"]);
    await store.release(first.id, first.token);
    await store.release(second.id, second.token);
    assert.equal((await store.listLeases()).length, 0);
  } finally {
    await removeStore(store);
  }
});

test("a writer consults readers, posts a request, and can proceed after release", async () => {
  const store = await tempStore();
  try {
    const activeReader = await reader(store, "long-running tests");
    await assert.rejects(
      () => store.acquire({ kind: "write", purpose: "apply change", resource: "shared-demo", operation: "update demo state" }),
      (error) => {
        assert.ok(error instanceof LeaseUnavailable);
        assert.equal(error.code, "LEASE_UNAVAILABLE");
        assert.equal(error.holders[0].id, activeReader.id);
        assert.equal(error.holders[0].token, undefined);
        assert.equal(error.request.message, "Requesting permission to update demo state");
        assert.equal(typeof error.request.token, "string");
        return true;
      },
    );
    assert.equal((await store.listRequests()).length, 1);
    assert.equal((await store.listRequests())[0].token, undefined);

    await store.release(activeReader.id, activeReader.token);
    const writer = await store.acquire({ kind: "write", purpose: "apply change", resource: "shared-demo" });
    assert.equal(writer.kind, "write");
    await store.release(writer.id, writer.token);
  } finally {
    await removeStore(store);
  }
});

test("status reports holders and resource state, and withdraw removes a request", async () => {
  const store = await tempStore();
  try {
    await store.seedResourceState({ resource: "shared-demo", applied: ["base"], builtBy: "branch/demo" });
    const activeReader = await reader(store, "local server");
    let request;
    try {
      await store.acquire({ kind: "write", purpose: "migration", resource: "shared-demo" });
    } catch (error) {
      request = error.request;
    }
    const status = await store.status();
    assert.equal(status.leases[0].purpose, "local server");
    assert.equal(status.leases[0].token, undefined);
    assert.equal(status.resources["shared-demo"].builtBy, "branch/demo");
    assert.equal(status.requests[0].id, request.id);
    assert.equal(status.requests[0].token, undefined);
    await assert.rejects(() => store.withdrawRequest(request.id, "wrong-token"), /token/);
    await assert.rejects(
      () => store.withdrawRequest(request.id, "00000000-0000-4000-8000-000000000000"),
      /token/,
    );
    assert.equal((await store.listRequests()).length, 1);
    assert.equal(await store.withdrawRequest(request.id, request.token), true);
    await store.release(activeReader.id, activeReader.token);
  } finally {
    await removeStore(store);
  }
});

test("preflight compares the demo record with the caller's expected names", async () => {
  const store = await tempStore();
  try {
    await store.seedResourceState({ resource: "shared-demo", applied: ["001-base", "002-other"], builtBy: "branch/other" });
    const result = await store.preflight({ resource: "shared-demo", expected: ["001-base", "003-mine"] });
    assert.equal(result.outcome, "behind+ahead");
    assert.deepEqual(result.missing, ["003-mine"]);
    assert.deepEqual(result.extra, ["002-other"]);

    await store.seedResourceState({ resource: "shared-demo", applied: ["001-base", "003-mine"] });
    assert.equal((await store.preflight({ resource: "shared-demo", expected: ["001-base", "003-mine"] })).outcome, "match");
  } finally {
    await removeStore(store);
  }
});

test("refused modifiers use the documented exit code", () => {
  assert.equal(REFUSED_EXIT_CODE, 75);
  assert.equal(FORMAT_VERSION, 2);
});

test("withdraw rejects ids that escape the request directory", async () => {
  const store = await tempStore();
  try {
    await store.seedResourceState({ resource: "shared-demo", applied: ["keep-me"], builtBy: "probe" });
    const before = JSON.stringify(await store.resourceState("shared-demo"));
    await assert.rejects(() => store.withdrawRequest("../resources/shared-demo", "x"));
    await assert.rejects(() => store.release("../resources/shared-demo", "x"));
    await assert.rejects(() => store.withdrawRequest("/tmp/not-a-lease", "x"));
    assert.equal(JSON.stringify(await store.resourceState("shared-demo")), before);
  } finally {
    await removeStore(store);
  }
});
