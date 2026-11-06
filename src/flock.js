import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

// The kernel drops this lock when the helper exits. The helper exits when its
// stdin closes, including when the parent is killed.
const SCRIPT = `
use Fcntl qw(:flock);
open my $fh, ">>", $ARGV[0] or die $!;
flock($fh, LOCK_EX) or die $!;
$| = 1;
print "locked\\n";
1 while sysread(STDIN, my $buf, 4096);
`;

function perlPath() {
  if (existsSync("/usr/bin/perl")) return "/usr/bin/perl";
  return "perl";
}

export function spawnFileLock(lockPath) {
  const child = spawn(perlPath(), ["-e", SCRIPT, lockPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", () => {});
  return child;
}

export function waitForLock(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let out = "";
    let settled = false;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish("timeout");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.includes("locked")) finish("locked");
    });
    child.once("error", (error) => finish(null, error));
    child.once("exit", (code, signal) => {
      if (!out.includes("locked")) finish(null, new Error(`lock helper exited ${code ?? signal}`));
    });
  });
}

export function releaseFileLock(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  child.stdin.end();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      resolve();
    }, 1000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
