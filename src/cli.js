#!/usr/bin/env node
import { LeaseStore, LeaseUnavailable, REFUSED_EXIT_CODE } from "./leases.js";

const { command, options } = parseArgs(process.argv.slice(2));
const store = new LeaseStore({ stateDir: options["state-dir"] });
const resource = options.resource || "demo-resource";

try {
  switch (command) {
    case "init":
      await store.init();
      print({ stateDir: store.stateDir }, options);
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
    case "help":
    case undefined:
      usage();
      break;
    default:
      throw new Error(`unknown command: ${command}`);
  }
} catch (error) {
  if (error instanceof LeaseUnavailable) {
    console.error(`REFUSED: ${error.message}`);
    for (const holder of error.holders || []) {
      console.error(`  ${holder.kind} ${holder.purpose} (${holder.where || "unknown location"})`);
    }
    if (error.request) console.error(`  Request: ${error.request.id} (withdraw it when no longer needed)`);
    process.exitCode = REFUSED_EXIT_CODE;
  } else {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

async function acquire() {
  const lease = await store.acquire({
    kind: options.kind,
    resource,
    purpose: options.purpose,
    where: options.where,
    expectedUntil: options["expected-until"],
    interruptible: options.interruptible === true,
    importance: options.importance || "normal",
    operation: options.operation || "change the resource",
    urgency: options.urgency || "normal",
    message: options.message,
  });
  print(lease, options);
  if (options.hold) {
    console.error(`Holding ${lease.kind} lease ${lease.id}. Press Ctrl-C to release it.`);
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await store.release(lease.id, lease.token);
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    // A pending Promise alone does not keep a Node process alive.
    const keepAlive = setInterval(() => {}, 60_000);
    await new Promise(() => {});
    clearInterval(keepAlive);
  }
}

async function release(withdraw) {
  const id = options.id || options._[0];
  if (!id) throw new Error(`${withdraw ? "withdraw" : "release"} requires an id`);
  const changed = withdraw
    ? await store.withdrawRequest(id) || await store.release(id, options.token)
    : await store.release(id, options.token);
  if (!changed) throw new Error(`nothing found for ${id}`);
  print({ id, released: true }, options);
}

async function status() {
  const result = await store.status();
  if (options.json) return print(result, options);
  console.log(`State: ${result.stateDir}`);
  for (const [name, state] of Object.entries(result.resources)) {
    const applied = state.applied.map((item) => typeof item === "string" ? item : item.name);
    console.log(`Resource ${name}: ${applied.length ? applied.join(", ") : "empty"}${state.builtBy ? ` (built by ${state.builtBy})` : ""}`);
  }
  console.log("Leases:");
  if (!result.leases.length) console.log("  none");
  for (const lease of result.leases) console.log(`  ${lease.kind} ${lease.resource}: ${lease.purpose} [${lease.id}]`);
  console.log("Requests:");
  if (!result.requests.length) console.log("  none");
  for (const request of result.requests) console.log(`  ${request.resource}: ${request.operation} [${request.id}] — ${request.message}`);
}

async function preflight() {
  const result = await store.preflight({ resource, expected: csv(options.expected) });
  if (options.json) return print(result, options);
  console.log(`${result.outcome}: ${resource}`);
  if (result.missing.length) console.log(`  missing from resource: ${result.missing.join(", ")}`);
  if (result.extra.length) console.log(`  extra on resource: ${result.extra.join(", ")}`);
  if (result.builtBy) console.log(`  resource built by: ${result.builtBy}`);
}

async function resourceCommand() {
  const action = options._[0] || "show";
  if (action === "show") return print(await store.resourceState(resource), options);
  if (action === "set") {
    const state = await store.setResourceState({ resource, applied: csv(options.applied), builtBy: options["built-by"] || "manual demo setup" });
    return print(state, options);
  }
  throw new Error(`unknown resource action: ${action}`);
}

function csv(value) {
  if (!value) return [];
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function print(value, _options) {
  console.log(JSON.stringify(value, null, 2));
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { _: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--hold" || arg === "--interruptible" || arg === "--json") {
      options[arg.slice(2)] = true;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = rest[index + 1];
      if (next && !next.startsWith("--")) {
        options[key] = next;
        index += 1;
      } else {
        options[key] = true;
      }
    } else {
      options._.push(arg);
    }
  }
  return { command, options };
}

function usage() {
  console.log(`Agent Leases reference CLI

Commands:
  init
  acquire --kind read|write --purpose TEXT [--resource NAME] [--hold]
  release ID [--token TOKEN]
  withdraw REQUEST_ID
  status [--json]
  preflight --expected item1,item2 [--resource NAME]
  resource show|set --applied item1,item2 [--built-by TEXT]

Set AGENT_LEASES_STATE_DIR to a shared directory before using the CLI.
A write acquisition exits 75 and posts a request when readers are active.`);
}
