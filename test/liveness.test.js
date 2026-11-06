import test from "node:test";
import assert from "node:assert/strict";
import { decideLiveness } from "../src/identity.js";

const local = { machineId: "machine-a", bootId: "boot-a", pidNamespace: "pid:[10]" };
const identity = {
  pid: 42,
  machineId: "machine-a",
  bootId: "boot-a",
  pidNamespace: "pid:[10]",
  startTicks: 100,
};

test("liveness treats only proven local death as dead", () => {
  assert.equal(decideLiveness(identity, local, { code: null, startTicks: 100 }), "alive");
  assert.equal(decideLiveness(identity, local, { code: "EPERM", startTicks: null }), "alive");
  assert.equal(decideLiveness(identity, local, { code: null, startTicks: null }), "alive");
  assert.equal(decideLiveness(identity, local, { code: null, startTicks: 101 }), "dead");
  assert.equal(decideLiveness(identity, local, { code: "ESRCH", startTicks: null }), "dead");
  assert.equal(decideLiveness(identity, local, { code: "EIO", startTicks: null }), "unknown");
  assert.equal(decideLiveness({ ...identity, pid: -1 }, local, { code: "ESRCH" }), "unknown");
  assert.equal(decideLiveness({ ...identity, pid: 1.5 }, local, { code: "ESRCH" }), "unknown");
  assert.equal(decideLiveness({ ...identity, machineId: "machine-b" }, local, { code: "ESRCH" }), "unknown");
  assert.equal(decideLiveness({ ...identity, bootId: "boot-b" }, local, { code: null, startTicks: 100 }), "dead");
  assert.equal(decideLiveness({ ...identity, pidNamespace: "pid:[99]" }, local, { code: null, startTicks: 100 }), "unknown");
  assert.equal(
    decideLiveness({ ...identity, pidNamespace: "pid:[99]", bootId: "boot-b" }, local, { code: null, startTicks: 100 }),
    "dead",
  );
  assert.equal(decideLiveness({ ...identity, bootId: null }, local, { code: "ESRCH" }), "unknown");
});
