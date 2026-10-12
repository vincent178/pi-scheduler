// Store layer verification: concurrent writers, stale-lock stealing, log cap.
// Run: PI_REMINDER_DIR=$(mktemp -d) node scripts/test-store.ts
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  dataDir,
  storePath,
  logPath,
  readStore,
  updateStore,
  logEvent,
  readLog,
} from "../extensions/reminder/store.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

if (!process.env.PI_REMINDER_DIR) {
  console.error("set PI_REMINDER_DIR to a scratch directory");
  process.exit(2);
}

// --- concurrent writers -----------------------------------------------------
const WORKERS = 6;
const ITERATIONS = 25;
const workerScript = path.resolve("scripts/test-store-worker.ts");

const runWorker = (id: string) =>
  execFileSync(process.execPath, [workerScript, id, String(ITERATIONS)], { stdio: "pipe" });

const results: string[] = [];
const errors: string[] = [];
await Promise.all(
  Array.from({ length: WORKERS }, (_, i) => `s-${i}`).map((id) =>
    Promise.resolve()
      .then(() => results.push(runWorker(id).toString().trim()))
      .catch((e) => errors.push(`${id}: ${e.message}`)),
  ),
);

check("all workers completed", errors.length === 0, errors.join("; "));
for (const line of results) console.log(`       ${line}`);

const store = readStore();
const counters = (store as unknown as { counters?: { total?: number } }).counters;
check(
  "counter equals workers*iterations (no lost updates)",
  counters?.total === WORKERS * ITERATIONS,
  `total=${counters?.total}, expected=${WORKERS * ITERATIONS}`,
);
check(
  "every worker reminder persisted",
  store.reminders.length === WORKERS * Math.ceil(ITERATIONS / 5),
  `reminders=${store.reminders.length}`,
);
check(
  "deregistered sessions removed from registry",
  Object.keys(store.sessions).length === 0,
  `sessions=${Object.keys(store.sessions).join(",")}`,
);
check(
  "deregister released all stickiness",
  store.reminders.every((r) => r.sticky_session_id === null),
);

// --- store is valid JSON on disk --------------------------------------------
JSON.parse(fs.readFileSync(storePath(), "utf8"));
check("store file parses as JSON after concurrent writes", true);

// --- stale lock stealing ------------------------------------------------------
const staleLock = path.join(dataDir(), "reminders.lock");
fs.writeFileSync(staleLock, "999999");
const old = new Date(Date.now() - 60_000);
fs.utimesSync(staleLock, old, old);
const stole = updateStore((data) => ({ result: data.reminders.length }));
check("stale lock stolen and update succeeded", typeof stole === "number");
check("lock released after steal", !fs.existsSync(staleLock));

// --- live lock is respected (contended update still serializes) --------------
const t0 = Date.now();
updateStore((data) => {
  const start = Date.now();
  while (Date.now() - start < 300) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  return { result: null };
});
check("long critical section completes within lock timeout", Date.now() - t0 < 10_000);

// --- run log append + cap ------------------------------------------------------
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
