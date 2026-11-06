import { stat, writeFile } from "node:fs/promises";
import { LeaseStore } from "../src/leases.js";

const [stateDir, kind, purpose, resource, goFile, resultFile] = process.argv.slice(2);

if (!stateDir || !resultFile) {
  console.error("usage: spawn-acquire.js stateDir kind purpose resource goFile resultFile");
  process.exit(2);
}

const deadline = Date.now() + 15_000;
let opened = false;
while (Date.now() < deadline) {
  try {
    await stat(goFile);
    opened = true;
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const store = new LeaseStore({ stateDir });
try {
  if (!opened) throw new Error("barrier timeout");
  const lease = await store.acquire({ kind, purpose, resource });
  await writeFile(resultFile, JSON.stringify({
    ok: true,
    id: lease.id,
    kind: lease.kind,
    pid: process.pid,
  }));
  const keepAlive = setInterval(() => {}, 60_000);
  await new Promise((resolve) => {
    const stop = () => {
      clearInterval(keepAlive);
      resolve();
    };
    setTimeout(stop, 30_000);
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
} catch (error) {
  await writeFile(resultFile, JSON.stringify({
    ok: false,
    name: error.name,
    code: error.code || null,
    message: error.message,
  }));
}
