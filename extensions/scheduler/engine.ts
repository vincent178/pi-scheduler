import {
  updateStore,
  readStore,
  isSessionAlive,
  touchSession,
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
  // A startup pick blocks only the occurrence shown in the picker.
  private pendingPick = new Map<string, string>();
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
      touchSession(data, sessionId);
      return { result: null };
    });
    logEvent("session_registered", { session: sessionId, cwd, project_root: projectRoot });

    // Overdue tasks must be pending-pick before the first sweep can fire them.
    const overdue = this.collectOverdue();

    this.heartbeatTimer = setInterval(() => {
      try {
        updateStore((data) => {
          touchSession(data, sessionId);
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
    const data = readStore();
    const overdue = data.tasks.filter(
      (r) =>
        inScope(r, this.host.cwd) &&
        Date.parse(r.next_fire_at) <= now.getTime() &&
        this.claimableByMe(data, r),
    );
    for (const r of overdue) {
      this.pendingPick.set(r.id, r.next_fire_at);
      logEvent("overdue_listed", { id: r.id, session: this.host.sessionId });
    }
    return overdue;
  }

  fireOverdue(r: ScheduledTask): boolean {
    if (this.stopped || !this.isPendingPick(r)) return false;
    const task = this.claimDue(r, true);
    if (!task) return false;
    this.pendingPick.delete(r.id);
    this.deliver(task);
    this.armTimers();
    return true;
  }

  /** Force-claim for this session regardless of due time or current owner, then deliver. */
  fireNow(id: string): boolean {
    this.pendingPick.delete(id);
    const task = updateStore((data) => {
      const r = data.tasks.find((x) => x.id === id);
      return { result: r ? this.claim(data, r, true) : null };
    });
    if (!task) return false;
    this.deliver(task);
    this.armTimers();
    return true;
  }

  /** Unpicked occurrences stay pending until the next session start. */
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
    // fireDue may have advanced next_fire_at; arm from a fresh read.
    this.armTimers();
  }

  private pruneSessions(data: StoreData): void {
    const now = Date.now();
    for (const [id, hb] of Object.entries(data.sessions)) {
      if (id !== this.host.sessionId && now - Date.parse(hb) > SESSION_PRUNE_MS) {
        delete data.sessions[id];
        logEvent("session_pruned", { session: id });
      }
    }
  }

  fireDue(data?: StoreData): void {
    const store = data ?? readStore();
    const now = Date.now();
    for (const r of store.tasks) {
      if (this.stopped) return;
      if (!inScope(r, this.host.cwd)) continue;
      if (Date.parse(r.next_fire_at) > now) continue;
      if (this.isPendingPick(r)) continue;
      if (!this.claimableByMe(store, r)) {
        if (!this.heldLogged.has(r.id)) {
          this.heldLogged.add(r.id);
          logEvent("sticky_held_skip", { id: r.id, owner: r.sticky_session_id, session: this.host.sessionId });
        }
        continue;
      }
      const task = this.claimDue(r);
      if (task) this.deliver(task);
    }
  }

  private isPendingPick(r: ScheduledTask): boolean {
    return this.pendingPick.get(r.id) === r.next_fire_at;
  }

  private claimDue(r: ScheduledTask, manual = false): ScheduledTask | null {
    return updateStore((data) => {
      const fresh = data.tasks.find((x) => x.id === r.id);
      if (!fresh || fresh.next_fire_at !== r.next_fire_at) return { result: null };
      const now = new Date();
      if (Date.parse(fresh.next_fire_at) > now.getTime() || !inScope(fresh, this.host.cwd)) return { result: null };
      if (!this.claimableByMe(data, fresh)) return { result: null };
      return { result: this.claim(data, fresh, manual, now) };
    });
  }

  private projectOwner(data: StoreData, r: ScheduledTask): string | null {
    // The first live owner resolves legacy stores with split project ownership.
    const owner = data.tasks.find((candidate) =>
      candidate.scope === "project" &&
      candidate.project_root === r.project_root &&
      candidate.sticky_session_id !== null &&
      isSessionAlive(data, candidate.sticky_session_id)
    )?.sticky_session_id;
    return owner ?? null;
  }

  private claimableByMe(data: StoreData, r: ScheduledTask): boolean {
    if (r.scope === "project") {
      const owner = this.projectOwner(data, r);
      return owner === null || owner === this.host.sessionId;
    }
    if (!r.sticky_session_id || r.sticky_session_id === this.host.sessionId) return true;
    return !isSessionAlive(data, r.sticky_session_id);
  }

  private claim(data: StoreData, r: ScheduledTask, manual: boolean, now = new Date()): ScheduledTask {
    const claimed = r.scope === "project"
      ? data.tasks.filter((candidate) =>
        candidate.scope === "project" && candidate.project_root === r.project_root
      )
      : [r];
    for (const task of claimed) {
      const previousOwner = task.sticky_session_id;
      if (previousOwner === this.host.sessionId) continue;
      task.sticky_session_id = this.host.sessionId;
      if (previousOwner) {
        logEvent("sticky_transferred", { id: task.id, from: previousOwner, to: this.host.sessionId });
      } else {
        logEvent("sticky_claimed", { id: task.id, session: this.host.sessionId });
      }
    }

    if (r.schedule.type === "once") {
      data.tasks = data.tasks.filter((x) => x.id !== r.id);
    } else {
      r.next_fire_at = manual && Date.parse(r.next_fire_at) > now.getTime()
        ? r.next_fire_at // manual fire of a future task keeps its slot
        : advanceNextFire(r.schedule, now)!;
    }

    const snapshot = { ...r };
    logEvent("fired", { id: r.id, session: this.host.sessionId, delivery: r.delivery, manual });
    if (r.schedule.type === "once") logEvent("deleted_after_fire", { id: r.id });
    return snapshot;
  }

  private armTimers(data?: StoreData): void {
    const store = data ?? readStore();
    const live = new Set(store.tasks.map((r) => r.id));
    for (const [id, t] of this.timers) {
      if (!live.has(id)) {
        clearTimeout(t);
        this.timers.delete(id);
      }
    }
    const now = Date.now();
    for (const r of store.tasks) {
      if (!inScope(r, this.host.cwd) || this.isPendingPick(r)) continue;
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
        // Coalesce by task id: a backlogged recurring task flushes once, latest copy.
        const i = this.queue.findIndex((q) => q.id === r.id);
        if (i >= 0) {
          this.queue[i] = r;
          logEvent("deferred_coalesced", { id: r.id, session: this.host.sessionId, reason: "agent busy" });
        } else {
          this.queue.push(r);
          logEvent("deferred", { id: r.id, session: this.host.sessionId, reason: "agent busy" });
        }
        return;
      }
      this.host.deliverPrompt(taskText(r));
    } catch (err) {
      logEvent("error", { id: r.id, session: this.host.sessionId, message: `deliver: ${String(err)}` });
    }
  }

  private flushQueue(): void {
    // isBusy also covers compaction, where prompt() throws regardless of deliverAs.
    if (this.host.isBusy()) return;
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
    const data = readStore();
    const byProject = new Map<string, number>();
    for (const r of data.tasks) {
      if (inScope(r, this.host.cwd)) continue;
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
