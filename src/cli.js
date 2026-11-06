#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import { LeaseStore, LeaseUnavailable, REFUSED_EXIT_CODE } from "./leases.js";
import { sanitizeText } from "./validate.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const FLAG_OPTIONS = new Set(["hold", "interruptible", "json", "strict"]);
const VALUE_OPTIONS = new Set([
  "state-dir", "kind", "purpose", "resource", "where", "expected-until", "importance",
  "operation", "urgency", "message", "token", "expected", "applied", "built-by", "lease",
]);
const COMMAND_OPTIONS = {
  init: ["state-dir", "json"],
  acquire: ["state-dir", "json", "kind", "purpose", "resource", "hold", "where", "expected-until", "interruptible", "importance", "operation", "urgency", "message"],
  release: ["state-dir", "json", "token"],
  withdraw: ["state-dir", "json", "token"],
  status: ["state-dir", "json"],
  preflight: ["state-dir", "json", "expected", "resource", "strict"],
  resource: ["state-dir", "json", "resource", "applied", "built-by", "lease", "token"],
  run: ["state-dir", "json", "kind", "purpose", "resource", "where", "expected-until", "interruptible", "importance", "operation", "urgency", "message"],
  reclaim: ["state-dir", "json"],
  help: [],
  version: [],
};

const parsed = parseArgs(process.argv.slice(2));
if (parsed.error) {
  emitError(parsed.error, parsed.options);
  process.exit(1);
}

const { command, options } = parsed;
if (command === "version") {
  console.log(pkg.version);
  process.exit(0);
}
if (command === "help" || command === undefined) {
  usage();
  process.exit(0);
}

const store = new LeaseStore({ stateDir: options["state-dir"] });
const resource = options.resource || "demo-resource";

try {
  switch (command) {
    case "init":
      await store.init();
      print({ stateDir: store.stateDir });
      break;
    case "acquire":
      await acquire();
      break;
    case "release":
      await release(false);
      break;
    case "withdraw":
      await release(true);
      break;
    case "status":
      await status();
      break;
    case "preflight":
      await preflight();
      break;
    case "resource":
      await resourceCommand();
      break;
    case "run":
      await runCommand();
      break;
    case "reclaim":
      print(await store.reclaim());
      break;
    default:
      throw new Error(`unknown command: ${command}`);
  }
} catch (error) {
  emitError(error, options);
  process.exitCode = error instanceof LeaseUnavailable ? REFUSED_EXIT_CODE : 1;
}

async function acquire() {
  const lease = await store.acquire(leaseSpec());
  print(lease);
  if (!options.hold) {
    console.error("Warning: this process is exiting, so the lease does not cover later work. Use --hold or run.");
    return;
  }
  console.error(`Holding ${lease.kind} lease ${lease.id}. Press Ctrl-C to release it.`);
  await holdUntilSignal(async () => {
    await store.release(lease.id, lease.token);
  });
}

async function runCommand() {
  const commandLine = options._;
  if (commandLine.length === 0) throw new Error("run requires a command after --");
  const lease = await store.acquire(leaseSpec());
  console.error(`Running under ${lease.kind} lease ${lease.id}.`);
  let child;
  try {
    const childEnv = { ...process.env };
    delete childEnv.NODE_CHANNEL_FD;
    delete childEnv.NODE_TEST_CONTEXT;
    child = spawn(commandLine[0], commandLine.slice(1), {
      stdio: "inherit",
      detached: true,
      env: childEnv,
    });
  } catch (error) {
    await store.release(lease.id, lease.token);
    throw error;
  }
  const outcomePromise = new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  let forwarded;
  const forward = (signal) => {
    forwarded = signal;
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); } catch { /* already gone */ }
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));
  if (!child.pid) {
    const outcome = await outcomePromise;
    await store.release(lease.id, lease.token);
    throw new Error(`failed to start command: ${outcome.error?.message || "unknown error"}`);
  }
  try {
    await store.supervise(lease.id, lease.token, child.pid);
  } catch (error) {
    const outcome = await Promise.race([
      outcomePromise,
      new Promise((resolve) => setTimeout(() => resolve(null), 1000)),
    ]);
    if (child.pid) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
    }
    await store.release(lease.id, lease.token);
    if (outcome && !outcome.error) process.exit(exitStatus(outcome, forwarded));
    throw error;
  }
  const outcome = await outcomePromise;
  if (child.pid) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
  }
  await store.release(lease.id, lease.token);
  process.exit(exitStatus(outcome, forwarded));
}

function leaseSpec() {
  return {
    kind: options.kind,
    resource,
    purpose: options.purpose,
    where: options.where,
    expectedUntil: options["expected-until"] ?? null,
    interruptible: options.interruptible === true,
    importance: options.importance || "normal",
    operation: options.operation || "change the resource",
    urgency: options.urgency || "normal",
    message: options.message || "",
  };
}

async function release(withdraw) {
  const id = options._[0];
  if (!id) throw new Error(`${withdraw ? "withdraw" : "release"} requires an id`);
  if (!options.token) throw new Error(`${withdraw ? "withdraw" : "release"} requires --token`);
  const changed = withdraw
    ? await store.withdrawRequest(id, options.token)
    : await store.release(id, options.token);
  if (!changed) throw new Error(`nothing found for ${id}`);
  print({ id, released: true });
}

async function status() {
  const result = await store.status();
  if (options.json) return print(result);
  console.log(`State: ${result.stateDir}`);
  for (const [name, state] of Object.entries(result.resources)) {
    if (state.uncertain) {
      console.log(`Resource ${name}: unknown (${sanitizeText(state.reason)})`);
      continue;
    }
    if (state.absent) {
      console.log(`Resource ${name}: absent`);
      continue;
    }
    const applied = state.applied.map((item) => item.name);
    console.log(`Resource ${name}: ${applied.length ? applied.join(", ") : "empty"}${state.builtBy ? ` (built by ${sanitizeText(state.builtBy)})` : ""}`);
  }
  console.log("Leases:");
  if (!result.leases.length) console.log("  none");
  for (const lease of result.leases) {
    if (lease.uncertain) {
      console.log(`  uncertain ${lease.resource || "global"}: ${sanitizeText(lease.reason)} [${lease.id || "no id"}]`);
      continue;
    }
    console.log(`  ${lease.kind} ${lease.resource}: ${sanitizeText(lease.purpose)} [${lease.id}]`);
  }
  console.log("Requests:");
  if (!result.requests.length) console.log("  none");
  for (const request of result.requests) {
    if (request.uncertain) {
      console.log(`  uncertain: ${sanitizeText(request.reason)} [${request.id || "no id"}]`);
      continue;
    }
    console.log(`  ${request.resource}: ${sanitizeText(request.operation)} [${request.id}] — ${sanitizeText(request.message)}`);
  }
}

async function preflight() {
  const result = await store.preflight({ resource, expected: csv(options.expected) });
  if (options.json) print(result);
  else {
    console.log(`${result.outcome}: ${resource}`);
    if (result.reason && result.outcome === "unknown") console.log(`  ${sanitizeText(result.reason)}`);
    if (result.missing.length) console.log(`  missing from resource: ${result.missing.join(", ")}`);
    if (result.extra.length) console.log(`  extra on resource: ${result.extra.join(", ")}`);
    if (result.builtBy) console.log(`  resource built by: ${sanitizeText(result.builtBy)}`);
  }
  if (options.strict && result.outcome !== "match") process.exitCode = 2;
}

async function resourceCommand() {
  const action = options._[0] || "show";
  if (action === "show") return print(await store.resourceState(resource));
  if (action === "seed") {
    console.error("Warning: resource seed is an unguarded demo fixture. It does not check leases.");
    return print(await store.seedResourceState({
      resource,
      applied: csv(options.applied),
      builtBy: options["built-by"] || "manual demo setup",
    }));
  }
  if (action === "set") {
    return print(await store.setResourceState({
      resource,
      applied: csv(options.applied),
      builtBy: options["built-by"] || "manual demo setup",
      leaseId: options.lease,
      token: options.token,
    }));
  }
  throw new Error(`unknown resource action: ${action}`);
}

function holdUntilSignal(onStop) {
  return new Promise((resolve) => {
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      try {
        await onStop();
      } catch (error) {
        console.error(`ERROR: ${sanitizeText(error.message)}`);
      }
      resolve();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    setInterval(() => {}, 60_000);
  });
}

function exitStatus(outcome, forwarded) {
  if (forwarded === "SIGINT") return 130;
  if (forwarded === "SIGTERM") return 143;
  if (outcome?.signal) return 128 + (os.constants.signals[outcome.signal] || 0);
  if (outcome?.error) return 1;
  return outcome?.code ?? 1;
}

function csv(value) {
  if (!value) return [];
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

function emitError(error, options = {}) {
  const message = typeof error === "string" ? error : error.message;
  if (options.json) {
    const body = {
      ok: false,
      code: error.code || "ERROR",
      message,
      reason: error.reason || null,
      holders: error.holders || [],
      request: error.request ? {
        id: error.request.id,
        resource: error.request.resource,
        operation: error.request.operation,
        message: error.request.message,
        token: error.request.token,
      } : null,
    };
    console.error(JSON.stringify(body, null, 2));
    return;
  }
  if (error instanceof LeaseUnavailable) {
    console.error(`REFUSED: ${sanitizeText(message)}`);
    for (const holder of error.holders || []) {
      const label = holder.uncertain ? "uncertain" : holder.kind;
      console.error(`  ${label} ${sanitizeText(holder.purpose || holder.reason || "unknown")} (${sanitizeText(holder.where || "unknown location")})`);
    }
    if (error.request) {
      console.error(`  Request: ${error.request.id} token: ${error.request.token} (withdraw it when no longer needed)`);
    }
    return;
  }
  console.error(`ERROR: ${sanitizeText(message)}`);
}

function parseArgs(argv) {
  const options = { _: [] };
  const divider = argv.indexOf("--");
  const head = divider === -1 ? argv : argv.slice(0, divider);
  const tail = divider === -1 ? [] : argv.slice(divider + 1);
  if (head.includes("--help") || head.includes("-h") || head.length === 0) {
    return { command: "help", options };
  }
  if (head.includes("--version")) return { command: "version", options };
  const [command, ...rest] = head;
  options._ = [...tail];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) {
      options._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (key === "wait") {
      return { command, options, error: "--wait is not implemented; a blocked acquire exits 75 immediately" };
    }
    if (FLAG_OPTIONS.has(key)) {
      options[key] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(key)) {
      return { command, options, error: `unknown option --${key}` };
    }
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) return { command, options, error: `--${key} requires a value` };
    options[key] = next;
    index += 1;
  }
  const allowed = COMMAND_OPTIONS[command];
  if (!allowed) return { command, options, error: `unknown command: ${command}` };
  for (const key of Object.keys(options)) {
    if (key === "_") continue;
    if (!allowed.includes(key)) return { command, options, error: `--${key} is not valid for ${command}` };
  }
  return { command, options };
}

function usage() {
  console.log(`Agent Leases reference CLI ${pkg.version}

Commands:
  init [--state-dir DIR]
  acquire --kind read|write --purpose TEXT [--resource NAME] [--hold]
  run --kind read|write --purpose TEXT [--resource NAME] -- COMMAND [ARGS]
  release ID --token TOKEN
  withdraw REQUEST_ID --token TOKEN
  status [--json]
  preflight --expected item1,item2 [--resource NAME] [--strict]
  resource show|seed|set [--applied item1,item2] [--built-by TEXT]
  reclaim

A write acquire exits ${REFUSED_EXIT_CODE} when another writer or a reader holds the
resource. expectedUntil is an estimate, not a TTL. acquire without --hold does
not cover a later command; use run or --hold so the lease lasts as long as the
work. resource seed is an unguarded demo fixture. resource set requires
--lease and --token for a live write lease.

Set AGENT_LEASES_STATE_DIR, or pass --state-dir, before using a shared store.
The store is local to one Linux host and one PID namespace.`);
}
