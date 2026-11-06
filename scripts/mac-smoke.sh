#!/bin/sh
# Manual check for one machine. Run from a checkout on macOS or Linux:
#   sh scripts/mac-smoke.sh
# It acquires, runs, refuses a second writer, releases, and cleans up a killed holder.
set -u
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT" || exit 1
STATE=$(mktemp -d "${TMPDIR:-/tmp}/agent-leases-mac-smoke.XXXXXX")
export AGENT_LEASES_STATE_DIR="$STATE"
fails=0
run_cli() {
  node src/cli.js "$@"
}
HOLD_PID=""
RUN_PID=""

say_pass() { printf 'PASS: %s\n' "$1"; }
say_fail() { printf 'FAIL: %s\n' "$1"; fails=$((fails + 1)); }

cleanup() {
  if [ -n "$HOLD_PID" ]; then kill -9 "$HOLD_PID" 2>/dev/null || true; fi
  if [ -n "$RUN_PID" ]; then kill -9 "$RUN_PID" 2>/dev/null || true; fi
  if [ -n "${SLEEP_PID:-}" ]; then kill -9 "$SLEEP_PID" 2>/dev/null || true; fi
  rm -rf "$STATE"
}
trap cleanup EXIT

wait_for_lease() {
  node --input-type=module -e '
    import { readdir } from "node:fs/promises";
    import path from "node:path";
    const dir = path.join(process.env.AGENT_LEASES_STATE_DIR, "leases");
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const names = await readdir(dir);
        if (names.some((name) => name.endsWith(".json"))) process.exit(0);
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    process.exit(1);
  '
}

holder_pid() {
  node --input-type=module -e '
    import { readdir, readFile } from "node:fs/promises";
    import path from "node:path";
    const dir = path.join(process.env.AGENT_LEASES_STATE_DIR, "leases");
    const names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
    if (!names.length) process.exit(1);
    const lease = JSON.parse(await readFile(path.join(dir, names[0]), "utf8"));
    process.stdout.write(String(lease.pid));
  '
}

run_cli init >/dev/null || { say_fail "init"; exit 1; }

OUT=$(run_cli acquire --kind read --purpose "smoke acquire") || { say_fail "acquire"; exit 1; }
ID=$(printf '%s' "$OUT" | node --input-type=module -e 'let s=""; process.stdin.on("data", (d) => { s += d; }); process.stdin.on("end", () => { process.stdout.write(JSON.parse(s).id); });')
TOKEN=$(printf '%s' "$OUT" | node --input-type=module -e 'let s=""; process.stdin.on("data", (d) => { s += d; }); process.stdin.on("end", () => { process.stdout.write(JSON.parse(s).token); });')
run_cli release "$ID" --token "$TOKEN" >/dev/null || { say_fail "release"; exit 1; }
say_pass "acquire and release"

node src/cli.js acquire --kind write --purpose "smoke holder" --hold >"$STATE/hold.out" 2>"$STATE/hold.err" &
HOLD_PID=$!
if wait_for_lease; then
  run_cli acquire --kind write --purpose "intruder" >/dev/null 2>"$STATE/intruder.err"
  code=$?
  if [ "$code" -eq 75 ]; then
    say_pass "second process refused while acquire --hold is alive"
  else
    say_fail "second process exited $code, expected 75"
  fi
else
  say_fail "acquire --hold did not publish a lease"
fi
kill -9 "$HOLD_PID" 2>/dev/null || true
wait "$HOLD_PID" 2>/dev/null || true
HOLD_PID=""

cleaned=0
i=0
while [ "$i" -lt 25 ]; do
  if run_cli acquire --kind write --purpose "after kill" >"$STATE/after.json" 2>"$STATE/after.err"; then
    cleaned=1
    break
  fi
  i=$((i + 1))
  sleep 0.2
done
if [ "$cleaned" -eq 1 ]; then
  say_pass "killed holder cleaned up"
  AFTER_ID=$(node --input-type=module -e 'const fs=await import("node:fs/promises"); const body=JSON.parse(await fs.readFile(process.argv[1], "utf8")); process.stdout.write(body.id + "\n" + body.token);' "$STATE/after.json")
  AFTER_LEASE=$(printf '%s\n' "$AFTER_ID" | sed -n '1p')
  AFTER_TOKEN=$(printf '%s\n' "$AFTER_ID" | sed -n '2p')
  run_cli release "$AFTER_LEASE" --token "$AFTER_TOKEN" >/dev/null || say_fail "release after cleanup"
else
  say_fail "killed holder still blocks a new acquire"
fi

node src/cli.js run --kind read --purpose "smoke run" -- sleep 30 >"$STATE/run.out" 2>"$STATE/run.err" &
RUN_PID=$!
if wait_for_lease; then
  run_cli acquire --kind write --purpose "intruder during run" >/dev/null 2>"$STATE/run-intruder.err"
  code=$?
  if [ "$code" -eq 75 ]; then
    say_pass "second process refused while run is in progress"
  else
    say_fail "run refusal exited $code, expected 75"
  fi
  SLEEP_PID=$(holder_pid || true)
else
  say_fail "run did not publish a lease"
fi
if [ -n "${SLEEP_PID:-}" ]; then kill -9 "$SLEEP_PID" 2>/dev/null || true; fi
kill -9 "$RUN_PID" 2>/dev/null || true
wait "$RUN_PID" 2>/dev/null || true
RUN_PID=""

if [ "$fails" -eq 0 ]; then
  printf 'ALL PASS\n'
  exit 0
fi
printf 'FAILED %s\n' "$fails"
exit 1
