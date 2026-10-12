import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OnceSchedule {
  type: "once";
  /** ISO 8601 timestamp */
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
  /** Project root for project-scoped tasks; null for global. */
  project_root: string | null;
  /** Session that owns this task while alive; null = unowned. */
  sticky_session_id: string | null;
  created_at: string;
  next_fire_at: string;
  last_fired_at: string | null;
  enabled: boolean;
}

export interface SessionPresence {
  pid: number;
  cwd: string;
  project_root: string;
  /** ISO 8601; a session is alive only while this stays fresh. */
  heartbeat_at: string;
}

export interface StoreData {
  version: 1;
  tasks: ScheduledTask[];
  sessions: Record<string, SessionPresence>;
}

export interface LogEvent {
  ts: string;
  event: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function dataDir(): string {
  return process.env.PI_SCHEDULER_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

export function storePath(): string {
  return path.join(dataDir(), "scheduler.json");
}

export function logPath(): string {
  return path.join(dataDir(), "scheduler.log");
}

function lockPath(): string {
  return path.join(dataDir(), "scheduler.lock");
}

function ensureDir(): void {
  fs.mkdirSync(dataDir(), { recursive: true });
}

// ---------------------------------------------------------------------------
// Lockfile
// ---------------------------------------------------------------------------

const STALE_LOCK_MS = 30_000;
const LOCK_RETRY_MS = 25;
const LOCK_MAX_WAIT_MS = 10_000;

function acquireLock(): void {
  ensureDir();
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lockPath(), "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Steal a lock whose holder evidently died mid-write.
      try {
        const stat = fs.statSync(lockPath());
        if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          fs.unlinkSync(lockPath());
          continue;
        }
      } catch {
        // Lock vanished between open and stat; retry immediately.
        continue;
      }
      if (Date.now() - start > LOCK_MAX_WAIT_MS) {
        throw new Error(`timed out acquiring task store lock at ${lockPath()}`);
      }
      const wait = LOCK_RETRY_MS + Math.floor(Math.random() * LOCK_RETRY_MS);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
  }
}

function releaseLock(): void {
  try {
    fs.unlinkSync(lockPath());
  } catch {
    // Already gone (stolen as stale or never held); nothing to do.
  }
}

/** Run fn while holding the store lockfile. Synchronous by design: the store is tiny. */
export function withLock<T>(fn: () => T): T {
  acquireLock();
  try {
    return fn();
  } finally {
    releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Store read/write (tmp-write + rename)
// ---------------------------------------------------------------------------

function emptyStore(): StoreData {
  return { version: 1, tasks: [], sessions: {} };
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
      version: 1,
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {},
    };
  } catch {
    // Preserve the corrupt file for inspection, then start clean.
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

/**
 * Locked read-modify-write. The mutator receives the current store, mutates it
 * (or returns a replacement via `data`), and returns a `result` for the caller.
 */
export function updateStore<T>(fn: (data: StoreData) => { data?: StoreData; result: T }): T {
  return withLock(() => {
    const current = readStore();
    const { data, result } = fn(current);
    writeStore(data ?? current);
    return result;
  });
}

// ---------------------------------------------------------------------------
// Session presence registry
// ---------------------------------------------------------------------------

/** Heartbeats older than this mark a session dead (heartbeat interval is 30s). */
export const SESSION_STALE_MS = 90_000;

export function isSessionAlive(data: StoreData, sessionId: string, now = Date.now()): boolean {
  const s = data.sessions[sessionId];
  if (!s) return false;
  return now - Date.parse(s.heartbeat_at) < SESSION_STALE_MS;
}

export function registerSession(
  data: StoreData,
  sessionId: string,
  presence: Omit<SessionPresence, "heartbeat_at">,
): void {
  data.sessions[sessionId] = { ...presence, heartbeat_at: new Date().toISOString() };
}

export function heartbeat(data: StoreData, sessionId: string): void {
  const s = data.sessions[sessionId];
  if (s) s.heartbeat_at = new Date().toISOString();
}

/**
 * Remove a session from the registry and release every task it owned, so
 * another in-scope session can claim them without waiting for staleness.
 * Returns the ids of tasks whose stickiness was released.
 */
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

// ---------------------------------------------------------------------------
// Run log (append-only JSONL, capped)
// ---------------------------------------------------------------------------

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
  withLock(() => {
    // Re-check under the lock; another process may have truncated already.
    let current: number;
    try {
      current = fs.statSync(logPath()).size;
    } catch {
      return;
    }
    if (current <= LOG_CAP_BYTES) return;
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
  });
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

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

export function newTaskId(): string {
  return `t-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}
