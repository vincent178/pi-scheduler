import {
  updateStore,
  isSessionAlive,
  registerSession,
  heartbeat,
  deregisterSession,
  logEvent,
  SESSION_STALE_MS,
  type ScheduledTask,
  type StoreData,
} from "./store.ts";
import { advanceNextFire } from "./schedule.ts";
import { inScope } from "./project.ts";

export interface EngineHost {
  sessionId: string;
  cwd: string;
  projectRoot: string;
  deliverPrompt(text: string): void;
  notify(text: string): void;
  isBusy(): boolean;
  /** Subscribe to agent-settled; returns an unsubscribe function. */
  onIdle(cb: () => void): () => void;
}

export type ClaimResult = "claimed" | "held" | "not_due" | "gone" | "pending_pick";

const HEARTBEAT_MS = 30_000;
const SWEEP_MS = 60_000;
// setTimeout clamps past this; the sweep covers far-future tasks.
const MAX_TIMER_MS = 2_147_483_647;
const SESSION_PRUNE_MS = 10 * SESSION_STALE_MS;

export function taskText(r: ScheduledTask): string {
  return `⏰ Scheduled task: ${r.prompt}`;
}

export class Engine {
  private readonly host: EngineHost;
  private timers = new Map<string, NodeJS.Timeout>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private unsubscribeIdle: (() => void) | null = null;
  private queue: ScheduledTask[] = [];
  /** Overdue tasks awaiting the session-start pick; never auto-fired. */
  private pendingPick = new Set<string>();
  private heldLogged = new Set<string>();
  private stopped = false;

  constructor(host: EngineHost) {
    this.host = host;
    // Subscribed here, not in start(), so tests can drive delivery without timers.
    this.unsubscribeIdle = this.host.onIdle(() => this.flushQueue());
  }

  /** Must run from session_start. Returns overdue tasks for the pick UI. */
  start(): ScheduledTask[] {
    const { sessionId, cwd, projectRoot } = this.host;
    updateStore((data) => {
      registerSession(data, sessionId, { pid: process.pid, cwd, project_root: projectRoot });
      return { result: null };
    });
    logEvent("session_registered", { session: sessionId, cwd, project_root: projectRoot });

    // Overdue tasks must be pending-pick before the first sweep can fire them.
    const overdue = this.collectOverdue();

    this.heartbeatTimer = setInterval(() => {
      try {
        updateStore((data) => {
          heartbeat(data, sessionId);
          return { result: null };
        });
      } catch (err) {
        logEvent("error", { session: sessionId, message: `heartbeat: ${String(err)}` });
      }
    }, HEARTBEAT_MS);
    this.heartbeatTimer.unref();

    this.sweepTimer = setInterval(() => this.safeSweep(), SWEEP_MS);
    this.sweepTimer.unref();

    this.sweep();
    this.emitDigest();
    return overdue;
  }

  shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;

    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.unsubscribeIdle?.();

    const { sessionId } = this.host;
    try {
      const released = updateStore((data) => ({ result: deregisterSession(data, sessionId) }));
      for (const id of released) logEvent("sticky_released", { id, session: sessionId });
      logEvent("session_deregistered", { session: sessionId, released: released.length });
    } catch (err) {
      logEvent("error", { session: sessionId, message: `shutdown: ${String(err)}` });
    }
  }

  collectOverdue(now: Date = new Date()): ScheduledTask[] {
    const data = updateStore((d) => ({ result: d }));
    const overdue = data.tasks.filter(
      (r) =>
        r.enabled &&
        inScope(r, this.host.cwd) &&
        Date.parse(r.next_fire_at) <= now.getTime() &&
        this.claimableByMe(data, r),
    );
    for (const r of overdue) {
      this.pendingPick.add(r.id);
      logEvent("overdue_listed", { id: r.id, session: this.host.sessionId });
    }
    return overdue;
  }

  /** Force-claim for this session regardless of due time or current owner, then deliver. */
  fireNow(id: string): boolean {
    this.pendingPick.delete(id);
    let task: ScheduledTask | null = null;
    const result = updateStore((data) => {
      const r = data.tasks.find((x) => x.id === id);
      if (!r || !r.enabled) return { result: "gone" as ClaimResult };
      task = this.claim(data, r, true);
      return { result: r.sticky_session_id === this.host.sessionId ? ("claimed" as ClaimResult) : ("gone" as ClaimResult) };
    });
    if (result === "gone" || !task) return false;
    this.deliver(task);
    this.armTimers();
    return true;
  }

  /** Unpicked overdue tasks stay pending until the next session start. */
  snoozeOverdue(id: string): void {
    logEvent("overdue_snoozed", { id, session: this.host.sessionId });
  }

  private safeSweep(): void {
    try {
      this.sweep();
    } catch (err) {
      logEvent("error", { session: this.host.sessionId, message: `sweep: ${String(err)}` });
    }
  }

  sweep(): void {
    const data = updateStore((d) => {
      this.pruneSessions(d);
      return { result: d };
    });
    this.fireDue(data);
    this.armTimers(data);
  }

  private pruneSessions(data: StoreData): void {
    const now = Date.now();
    for (const [id, s] of Object.entries(data.sessions)) {
      if (id !== this.host.sessionId && now - Date.parse(s.heartbeat_at) > SESSION_PRUNE_MS) {
        delete data.sessions[id];
        logEvent("session_pruned", { session: id });
      }
    }
  }

  fireDue(data?: StoreData): void {
    const store = data ?? updateStore((d) => ({ result: d }));
    const now = Date.now();
    for (const r of store.tasks) {
      if (this.stopped) return;
      if (!r.enabled || !inScope(r, this.host.cwd)) continue;
      if (Date.parse(r.next_fire_at) > now) continue;
      if (this.pendingPick.has(r.id)) continue;
      if (!this.claimableByMe(store, r)) {
        if (!this.heldLogged.has(r.id)) {
          this.heldLogged.add(r.id);
          logEvent("sticky_held_skip", { id: r.id, owner: r.sticky_session_id, session: this.host.sessionId });
        }
        continue;
      }
      const claimed = updateStore((d) => {
        const fresh = d.tasks.find((x) => x.id === r.id);
        if (!fresh || !fresh.enabled) return { result: "gone" as ClaimResult };
        if (Date.parse(fresh.next_fire_at) > Date.now()) return { result: "not_due" as ClaimResult };
        if (!this.claimableByMe(d, fresh)) return { result: "held" as ClaimResult };
        this.claim(d, fresh, false);
        return { result: (fresh.sticky_session_id === this.host.sessionId ? "claimed" : "gone") as ClaimResult };
      });
      if (claimed === "claimed") this.deliver(r);
    }
  }

  private claimableByMe(data: StoreData, r: ScheduledTask): boolean {
    if (!r.sticky_session_id || r.sticky_session_id === this.host.sessionId) return true;
    return !isSessionAlive(data, r.sticky_session_id);
  }

  private claim(data: StoreData, r: ScheduledTask, force: boolean): ScheduledTask {
    const previousOwner = r.sticky_session_id;
    const transferred = previousOwner !== null && previousOwner !== this.host.sessionId;
    const now = new Date();

    r.sticky_session_id = this.host.sessionId;
    r.last_fired_at = now.toISOString();
    if (r.schedule.type === "once") {
      data.tasks = data.tasks.filter((x) => x.id !== r.id);
    } else {
      r.next_fire_at = force && Date.parse(r.next_fire_at) > now.getTime()
        ? r.next_fire_at // manual fire of a future task keeps its slot
        : advanceNextFire(r.schedule, now)!;
    }

    const snapshot = { ...r };
    if (transferred) {
      logEvent("sticky_transferred", { id: r.id, from: previousOwner, to: this.host.sessionId });
    } else if (!previousOwner) {
      logEvent("sticky_claimed", { id: r.id, session: this.host.sessionId });
    }
    logEvent("fired", { id: r.id, session: this.host.sessionId, delivery: r.delivery, manual: force });
    if (r.schedule.type === "once") logEvent("deleted_after_fire", { id: r.id });
    return snapshot;
  }

  private armTimers(data?: StoreData): void {
    const store = data ?? updateStore((d) => ({ result: d }));
    const live = new Set(store.tasks.map((r) => r.id));
    for (const [id, t] of this.timers) {
      if (!live.has(id)) {
        clearTimeout(t);
        this.timers.delete(id);
      }
    }
    const now = Date.now();
    for (const r of store.tasks) {
      if (!r.enabled || !inScope(r, this.host.cwd) || this.pendingPick.has(r.id)) continue;
      if (!this.claimableByMe(store, r)) continue;
      const delay = Date.parse(r.next_fire_at) - now;
      if (delay <= 0) continue;
      if (this.timers.has(r.id)) continue;
      const timer = setTimeout(() => {
        this.timers.delete(r.id);
        this.safeSweep();
      }, Math.min(delay, MAX_TIMER_MS));
      timer.unref();
      this.timers.set(r.id, timer);
    }
  }

  private deliver(r: ScheduledTask): void {
    try {
      if (r.delivery === "notify") {
        this.host.notify(taskText(r));
        return;
      }
      if (this.host.isBusy()) {
        this.queue.push(r);
        logEvent("deferred", { id: r.id, session: this.host.sessionId, reason: "agent busy" });
        return;
      }
      this.host.deliverPrompt(taskText(r));
    } catch (err) {
      logEvent("error", { id: r.id, session: this.host.sessionId, message: `deliver: ${String(err)}` });
    }
  }

  private flushQueue(): void {
    const queued = this.queue.splice(0);
    for (const r of queued) {
      logEvent("deferred_flush", { id: r.id, session: this.host.sessionId });
      try {
        this.host.deliverPrompt(taskText(r));
      } catch (err) {
        logEvent("error", { id: r.id, session: this.host.sessionId, message: `flush: ${String(err)}` });
      }
    }
  }

  private emitDigest(): void {
    const data = updateStore((d) => ({ result: d }));
    const byProject = new Map<string, number>();
    for (const r of data.tasks) {
      if (!r.enabled || inScope(r, this.host.cwd)) continue;
      const key = r.project_root ?? "global";
      byProject.set(key, (byProject.get(key) ?? 0) + 1);
    }
    if (byProject.size === 0) return;
    const total = [...byProject.values()].reduce((a, b) => a + b, 0);
    const parts = [...byProject.entries()].map(([p, n]) => `${p} (${n})`).join(", ");
    logEvent("digest", { session: this.host.sessionId, count: total, projects: [...byProject.keys()] });
    this.host.notify(`⏰ ${total} pending task${total === 1 ? "" : "s"} in other projects: ${parts} — /schedule list --all`);
  }
}
