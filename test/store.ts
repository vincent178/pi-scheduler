// Store layer verification: concurrent writers, atomicity under races, log cap.
// Run: PI_SCHEDULER_DIR=$(mktemp -d) node test/store.ts
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  storePath,
  logPath,
  readStore,
  updateStore,
  logEvent,
  readLog,
} from "../extensions/scheduler/store.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function pathExists(path: string): boolean {
  try {
    fs.lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

if (!process.env.PI_SCHEDULER_DIR) {
  console.error("set PI_SCHEDULER_DIR to a scratch directory");
  process.exit(2);
}

const WORKERS = 6;
const ITERATIONS = 25;
const workerScript = path.resolve("test/store-worker.ts");

const runWorker = (id: string) =>
  promisify(execFile)(process.execPath, [workerScript, id, String(ITERATIONS)]);

updateStore(() => ({ result: null }));
const staleLock = `${storePath()}.lock`;
const liveOwner = `${process.pid}-${"f".repeat(32)}`;
fs.symlinkSync(liveOwner, staleLock);
const liveResult = spawnSync(process.execPath, [workerScript, "live-owner", "1"], { encoding: "utf8" });
check(
  "live owner lock is not evicted",
  liveResult.status !== 0 && liveResult.stderr.includes("Timed out waiting for the scheduler lock"),
);
fs.unlinkSync(staleLock);

const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
if (!deadPid) throw new Error("failed to create a dead process owner");
const deadOwner = `${deadPid}-${"0".repeat(32)}`;
fs.symlinkSync(deadOwner, staleLock);
fs.symlinkSync(deadOwner, `${staleLock}.recovery`);

const results: string[] = [];
const errors: string[] = [];
await Promise.all(
  Array.from({ length: WORKERS }, (_, i) => `s-${i}`).map((id) =>
    runWorker(id)
      .then(({ stdout }) => results.push(stdout.trim()))
      .catch((e) => errors.push(`${id}: ${e.message}`)),
  ),
);

check("all workers completed after simultaneous stale-lock recovery", errors.length === 0, errors.join("; "));
for (const line of results) console.log(`       ${line}`);

const store = readStore();
const counters = (store as unknown as { counters?: { total?: number } }).counters;
check(
  "counter preserves every concurrent update",
  counters?.total === WORKERS * ITERATIONS,
  `total=${counters?.total}, expected=${WORKERS * ITERATIONS}`,
);
check("worker tasks persisted", store.tasks.length >= 1, `tasks=${store.tasks.length}`);
check(
  "deregistered sessions removed from registry",
  Object.keys(store.sessions).length === 0,
  `sessions=${Object.keys(store.sessions).join(",")}`,
);
check(
  "deregister released all stickiness",
  store.tasks.every((r) => r.sticky_session_id === null),
);

JSON.parse(fs.readFileSync(storePath(), "utf8"));
check("store file parses as JSON after concurrent writes", true);
check(
  "store and recovery locks released",
  !pathExists(staleLock) &&
    !pathExists(`${staleLock}.recovery`) &&
    !pathExists(`${staleLock}.recovery.recovery`),
);

logEvent("test_marker", { n: 1 });
const marker = readLog().find((e) => e.event === "test_marker");
check("log event appended and readable", marker?.n === 1);

// push the log past the 1 MB cap
const bigLine = JSON.stringify({ ts: new Date().toISOString(), event: "filler", pad: "x".repeat(4000) });
fs.appendFileSync(logPath(), (bigLine + "\n").repeat(300)); // ~1.2 MB
logEvent("after_cap", { ok: true });

const cappedSize = fs.statSync(logPath()).size;
check("log truncated under cap", cappedSize <= 1_000_000, `size=${cappedSize}`);
const tail = readLog();
check("log still valid JSONL after truncation", tail.length > 0);
check("most recent event retained after truncation", tail.at(-1)?.event === "after_cap");

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
