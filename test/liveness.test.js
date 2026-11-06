import test from "node:test";
import assert from "node:assert/strict";
import { decideLiveness, parseBootTime, parseIOPlatformUUID } from "../src/identity.js";

const local = {
  platform: "linux",
  machineId: "machine-a",
  bootId: "boot-a",
  pidNamespace: "pid:[10]",
};
const identity = {
  platform: "linux",
  pid: 42,
  machineId: "machine-a",
  bootId: "boot-a",
  pidNamespace: "pid:[10]",
  startId: "100",
};

const darwinLocal = { platform: "darwin", machineId: "machine-a", bootId: "boot-a", pidNamespace: null };
const darwinIdentity = {
  platform: "darwin",
  pid: 7,
  machineId: "machine-a",
  bootId: "boot-a",
  pidNamespace: null,
  startId: "Fri Nov  6 12:00:00 2026",
};

test("liveness treats only proven local death as dead", () => {
  assert.equal(decideLiveness(identity, local, { code: null, startId: "100" }), "alive");
  assert.equal(decideLiveness(identity, local, { code: "EPERM", startId: "100" }), "alive");
  assert.equal(decideLiveness(identity, local, { code: null, startId: null }), "unknown");
  assert.equal(decideLiveness(identity, local, { code: "EPERM", startId: null }), "unknown");
  assert.equal(decideLiveness(identity, local, { code: null, startId: "101" }), "dead");
  assert.equal(decideLiveness(identity, local, { code: "ESRCH", startId: null }), "dead");
  assert.equal(decideLiveness(identity, local, { code: "EIO", startId: null }), "unknown");
  assert.equal(decideLiveness({ ...identity, pid: -1 }, local, { code: "ESRCH" }), "unknown");
  assert.equal(decideLiveness({ ...identity, pid: 1.5 }, local, { code: "ESRCH" }), "unknown");
  assert.equal(decideLiveness({ ...identity, machineId: "machine-b" }, local, { code: "ESRCH" }), "unknown");
  assert.equal(decideLiveness({ ...identity, bootId: "boot-b" }, local, { code: null, startId: "100" }), "dead");
  assert.equal(decideLiveness({ ...identity, pidNamespace: "pid:[99]" }, local, { code: null, startId: "100" }), "unknown");
  assert.equal(
    decideLiveness({ ...identity, pidNamespace: "pid:[99]", bootId: "boot-b" }, local, { code: null, startId: "100" }),
    "dead",
  );
  assert.equal(decideLiveness({ ...identity, bootId: null }, local, { code: "ESRCH" }), "unknown");
  assert.equal(decideLiveness({ ...identity, platform: "darwin" }, local, { code: "ESRCH" }), "unknown");
});

test("macOS liveness does not require a PID namespace and fails closed when a probe fails", () => {
  assert.equal(decideLiveness(darwinIdentity, darwinLocal, { code: "ESRCH", startId: null }), "dead");
  assert.equal(decideLiveness(darwinIdentity, darwinLocal, { code: null, startId: darwinIdentity.startId }), "alive");
  assert.equal(decideLiveness(darwinIdentity, darwinLocal, { code: null, startId: "other" }), "dead");
  assert.equal(decideLiveness(darwinIdentity, darwinLocal, { code: null, startId: null }), "unknown");
  assert.equal(decideLiveness(darwinIdentity, darwinLocal, { code: "EIO", startId: null }), "unknown");
  assert.equal(decideLiveness(darwinIdentity, darwinLocal, { code: "EPERM", startId: null }), "unknown");
  assert.equal(
    decideLiveness({ ...darwinIdentity, bootId: "other-boot" }, darwinLocal, { code: null, startId: darwinIdentity.startId }),
    "dead",
  );
});

test("darwin probe parsers keep the stable identity fields", () => {
  const ioreg = `
+-o Root  <class IOPlatformExpertDevice, id 0x1000003c4, registered, matched, active, busy 0>
  {
    "IOPlatformUUID" = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"
  }
`;
  assert.equal(parseIOPlatformUUID(ioreg), "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE");
  assert.equal(parseIOPlatformUUID("no uuid"), null);
  assert.equal(
    parseBootTime("{ sec = 1730000000, usec = 12 } Fri Nov  6 12:00:00 2026\n"),
    "{ sec = 1730000000, usec = 12 }",
  );
  assert.equal(parseBootTime("   "), null);
});
