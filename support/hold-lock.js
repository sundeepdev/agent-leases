import path from "node:path";
import { writeFileSync } from "node:fs";
import { spawnFileLock, waitForLock } from "../src/flock.js";

const stateDir = process.argv[2];
const readyFile = process.argv[3];
if (!stateDir || !readyFile) {
  console.error("usage: hold-lock.js stateDir readyFile");
  process.exit(2);
}

const child = spawnFileLock(path.join(stateDir, "lock"));
const outcome = await waitForLock(child, 5000);
if (outcome !== "locked") process.exit(1);
writeFileSync(readyFile, "ready");
setInterval(() => {}, 60_000);
