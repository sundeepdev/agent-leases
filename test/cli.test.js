import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LeaseStore } from "../src/leases.js";
import { testEnv } from "../support/helpers.js";

const cli = path.join(process.cwd(), "src/cli.js");

async function newDir() {
  return mkdtemp(path.join(os.tmpdir(), "agent-leases-cli-"));
}

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: testEnv(),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function leaseFiles(stateDir) {
  return (await readdir(path.join(stateDir, "leases")).catch(() => [])).filter((name) => name.endsWith(".json"));
}

test("the CLI rejects unknown options, missing values, and unimplemented --wait", async () => {
  const stateDir = await newDir();
  try {
    const unknown = await runCli(["acquire", "--kind", "read", "--purpose", "x", "--state-dir", stateDir, "--not-real"]);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /unknown option/);
    assert.equal((await leaseFiles(stateDir)).length, 0);

    const missing = await runCli(["acquire", "--kind", "read", "--purpose", "--state-dir", stateDir]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /requires a value/);
    assert.equal((await leaseFiles(stateDir)).length, 0);

    const wait = await runCli(["acquire", "--kind", "read", "--purpose", "x", "--wait", "--state-dir", stateDir]);
    assert.equal(wait.code, 1);
    assert.match(wait.stderr, /not implemented/);
    assert.equal((await leaseFiles(stateDir)).length, 0);

    const help = await runCli(["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /run --kind/);
    const version = await runCli(["--version"]);
    assert.equal(version.code, 0);
    assert.match(version.stdout, /0\.2\.0/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("preflight reports by default and stops in strict mode", async () => {
  const stateDir = await newDir();
  try {
    const seeded = await runCli([
      "resource", "seed", "--applied", "001-base", "--built-by", "seed", "--state-dir", stateDir,
    ]);
    assert.equal(seeded.code, 0, seeded.stderr);
    assert.match(seeded.stderr, /unguarded demo fixture/);

    const behind = await runCli(["preflight", "--expected", "001-base,002-local", "--state-dir", stateDir]);
    assert.equal(behind.code, 0, behind.stderr);
    assert.match(behind.stdout, /^behind: demo-resource/m);

    const strict = await runCli(["preflight", "--expected", "001-base,002-local", "--strict", "--state-dir", stateDir]);
    assert.equal(strict.code, 2);
    assert.match(strict.stdout, /^behind: demo-resource/m);

    const match = await runCli(["preflight", "--expected", "001-base", "--strict", "--state-dir", stateDir]);
    assert.equal(match.code, 0, match.stderr);
    assert.match(match.stdout, /^match: demo-resource/m);

    const absentDir = await newDir();
    const absent = await runCli(["preflight", "--expected", "001-base", "--state-dir", absentDir]);
    assert.equal(absent.code, 0);
    assert.match(absent.stdout, /^none: demo-resource/m);
    const absentStrict = await runCli(["preflight", "--expected", "001-base", "--strict", "--state-dir", absentDir]);
    assert.equal(absentStrict.code, 2);
    await rm(absentDir, { recursive: true, force: true });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a refused write is JSON on stderr and status hides tokens", async () => {
  const stateDir = await newDir();
  const store = new LeaseStore({ stateDir });
  try {
    const reader = await store.acquire({
      kind: "read",
      purpose: "hello\nREFUSED: forged",
      resource: "demo-resource",
    });
    const refused = await runCli([
      "acquire", "--kind", "write", "--purpose", "change", "--json", "--state-dir", stateDir,
    ]);
    assert.equal(refused.code, 75, refused.stderr);
    const body = JSON.parse(refused.stderr);
    assert.equal(body.ok, false);
    assert.equal(body.code, "LEASE_UNAVAILABLE");
    assert.equal(body.holders[0].token, undefined);
    assert.equal(body.holders[0].id, reader.id);
    assert.equal(typeof body.request.token, "string");

    const human = await runCli(["status", "--state-dir", stateDir]);
    assert.equal(human.code, 0, human.stderr);
    assert.equal(human.stdout.includes("\nREFUSED:"), false);
    assert.doesNotMatch(human.stdout, new RegExp(reader.token));
    assert.doesNotMatch(human.stdout, new RegExp(body.request.token));

    const withdrawn = await runCli([
      "withdraw", body.request.id, "--token", body.request.token, "--state-dir", stateDir,
    ]);
    assert.equal(withdrawn.code, 0, withdrawn.stderr);
    const bare = await runCli(["release", reader.id, "--state-dir", stateDir]);
    assert.equal(bare.code, 1);
    assert.match(bare.stderr, /requires --token/);
    await store.release(reader.id, reader.token);

    const unguarded = await runCli(["resource", "set", "--applied", "001-base", "--state-dir", stateDir]);
    assert.equal(unguarded.code, 1);
    assert.match(unguarded.stderr, /write lease/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
