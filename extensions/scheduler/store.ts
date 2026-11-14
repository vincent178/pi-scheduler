import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

export interface OnceSchedule {
  type: "once";
  at: string;
}

export interface IntervalSchedule {
  type: "interval";
  every_minutes: number;
}

export type Schedule = OnceSchedule | IntervalSchedule;

export type Delivery = "prompt" | "notify";
export type Scope = "project" | "global";

export interface ScheduledTask {
  id: string;
  prompt: string;
  schedule: Schedule;
  delivery: Delivery;
  scope: Scope;
  project_root: string | null;
  sticky_session_id: string | null;
  next_fire_at: string;
}

export interface StoreData {
  tasks: ScheduledTask[];
  /** sessionId -> last heartbeat ISO timestamp */
  sessions: Record<string, string>;
}

export interface LogEvent {
  ts: string;
  event: string;
  [key: string]: unknown;
}

export function dataDir(): string {
  return process.env.PI_SCHEDULER_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

export function storePath(): string {
  return path.join(dataDir(), "scheduler.json");
}

export function logPath(): string {
  return path.join(dataDir(), "scheduler.log");
}

function ensureDir(): void {
  fs.mkdirSync(dataDir(), { recursive: true });
}

// Atomic rename protects readers. The lock protects read-modify-write updates.

function emptyStore(): StoreData {
  return { tasks: [], sessions: {} };
}

export function readStore(): StoreData {
  ensureDir();
  let raw: string;
  try {
    raw = fs.readFileSync(storePath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoreData>;
    return {
      ...parsed,
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {},
    };
  } catch {
    fs.renameSync(storePath(), `${storePath()}.corrupt-${Date.now()}`);
    return emptyStore();
  }
}

function writeStore(data: StoreData): void {
  ensureDir();
  const tmp = `${storePath()}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, storePath());
}

const LOCK_RETRY_MS = 5;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 10_000;
const lockWaitArray = new Int32Array(new SharedArrayBuffer(4));

function lockPath(): string {
  return `${storePath()}.lock`;
}

function recoveryPath(): string {
  return `${lockPath()}.recovery`;
}

function removeStaleStoreLock(): void {
  // Only the recovery-lock holder may remove a stale store lock.
  try {
    fs.mkdirSync(recoveryPath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return;
    throw err;
  }

  try {
    const age = Date.now() - fs.statSync(lockPath()).mtimeMs;
    if (age > LOCK_STALE_MS) fs.rmSync(lockPath(), { recursive: true, force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  } finally {
    fs.rmdirSync(recoveryPath());
  }
}

function acquireStoreLock(): string {
  ensureDir();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    const owner = crypto.randomBytes(16).toString("hex");
    try {
      fs.mkdirSync(lockPath());
      try {
        fs.writeFileSync(path.join(lockPath(), owner), "");
        return owner;
      } catch (err) {
        fs.rmdirSync(lockPath());
        throw err;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    try {
      const age = Date.now() - fs.statSync(lockPath()).mtimeMs;
      if (age > LOCK_STALE_MS) {
        removeStaleStoreLock();
        continue;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }

    if (Date.now() >= deadline) throw new Error("Timed out waiting for the scheduler store lock");
    Atomics.wait(lockWaitArray, 0, 0, LOCK_RETRY_MS);
  }
}

function releaseStoreLock(owner: string): void {
  // The owner file prevents an expired holder from removing a replacement lock.
  try {
    fs.unlinkSync(path.join(lockPath(), owner));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }

  try {
    fs.rmdirSync(lockPath());
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY") throw err;
  }
}

export function updateStore<T>(fn: (data: StoreData) => { data?: StoreData; result: T }): T {
  const owner = acquireStoreLock();
  try {
    const current = readStore();
    const { data, result } = fn(current);
    writeStore(data ?? current);
    return result;
  } finally {
    releaseStoreLock(owner);
  }
}

// A session is dead once its heartbeat is older than this (heartbeat: 30s).
export const SESSION_STALE_MS = 90_000;

export function isSessionAlive(data: StoreData, sessionId: string, now = Date.now()): boolean {
  const hb = data.sessions[sessionId];
  if (!hb) return false;
  return now - Date.parse(hb) < SESSION_STALE_MS;
}

/** Register a session or refresh its heartbeat. */
export function touchSession(data: StoreData, sessionId: string): void {
  data.sessions[sessionId] = new Date().toISOString();
}

/** Also releases the session's sticky claims; returns the released task ids. */
export function deregisterSession(data: StoreData, sessionId: string): string[] {
  delete data.sessions[sessionId];
  const released: string[] = [];
  for (const r of data.tasks) {
    if (r.sticky_session_id === sessionId) {
      r.sticky_session_id = null;
      released.push(r.id);
    }
  }
  return released;
}

const LOG_CAP_BYTES = 1_000_000;
const LOG_KEEP_BYTES = 500_000;

export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  ensureDir();
  const line: LogEvent = { ts: new Date().toISOString(), event, ...fields };
  fs.appendFileSync(logPath(), JSON.stringify(line) + "\n");
  truncateLogIfNeeded();
}

function truncateLogIfNeeded(): void {
  let size: number;
  try {
    size = fs.statSync(logPath()).size;
  } catch {
    return;
  }
  if (size <= LOG_CAP_BYTES) return;
  const raw = fs.readFileSync(logPath(), "utf8");
  const lines = raw.split("\n");
  const kept: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    bytes += Buffer.byteLength(line) + 1;
    if (bytes > LOG_KEEP_BYTES) break;
    kept.unshift(line);
  }
  const tmp = `${logPath()}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, kept.join("\n") + "\n");
  fs.renameSync(tmp, logPath());
}

export function readLog(tail = 0): LogEvent[] {
  let raw: string;
  try {
    raw = fs.readFileSync(logPath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const events: LogEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line) as LogEvent);
    } catch {
      // Skip partially-written lines.
    }
  }
  return tail > 0 ? events.slice(-tail) : events;
}

export function newTaskId(): string {
  return `t-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}
