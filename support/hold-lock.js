import { writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { currentProcessIdentity } from "../src/identity.js";

const stateDir = process.argv[2];
const readyFile = process.argv[3];
if (!stateDir || !readyFile) {
  console.error("usage: hold-lock.js stateDir readyFile");
  process.exit(2);
}

const owner = { ...currentProcessIdentity(), token: randomUUID() };
writeFileSync(path.join(stateDir, "lock"), JSON.stringify(owner), { flag: "wx", mode: 0o600 });
writeFileSync(readyFile, "ready");
setInterval(() => {}, 60_000);
