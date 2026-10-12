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
  created_at: string;
  next_fire_at: string;
  last_fired_at: string | null;
}

export interface SessionPresence {
  pid: number;
  cwd: string;
  project_root: string;
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

// No cross-process lock: writes are atomic (tmp-write + rename) and a lost
// concurrent update is tolerated. Corrupt files are quarantined on read.

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

export function updateStore<T>(fn: (data: StoreData) => { data?: StoreData; result: T }): T {
  const current = readStore();
  const { data, result } = fn(current);
  writeStore(data ?? current);
  return result;
}

// A session is dead once its heartbeat is older than this (heartbeat: 30s).
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
