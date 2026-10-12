import {
  updateStore,
  isSessionAlive,
  registerSession,
  heartbeat,
  deregisterSession,
  logEvent,
  SESSION_STALE_MS,
  type Reminder,
  type StoreData,
} from "./store.ts";
import { advanceNextFire } from "./schedule.ts";
import { inScope } from "./project.ts";

// ---------------------------------------------------------------------------
// Host abstraction: keeps the engine testable without a live pi session.
// ---------------------------------------------------------------------------

export interface EngineHost {
  sessionId: string;
  cwd: string;
  projectRoot: string;
  /** Inject a user message the agent acts on. */
  deliverPrompt(text: string): void;
  /** Passive UI notification. */
  notify(text: string): void;
  /** True while the agent is mid-turn; prompt deliveries queue until idle. */
  isBusy(): boolean;
  /** Subscribe to agent-settled; returns an unsubscribe function. */
  onIdle(cb: () => void): () => void;
}

export type ClaimResult =
  | "claimed"
  | "transferred"
  | "held"
  | "not_due"
  | "gone"
  | "pending_pick";

const HEARTBEAT_MS = 30_000;
const SWEEP_MS = 60_000;
/** setTimeout clamps past this; rely on the sweep for far-future reminders. */
const MAX_TIMER_MS = 2_147_483_647;
/** Session registry entries older than this are pruned by the sweep. */
const SESSION_PRUNE_MS = 10 * SESSION_STALE_MS;

export function reminderText(r: Reminder): string {
  return `⏰ Reminder: ${r.prompt}`;
}

export class Engine {
  private readonly host: EngineHost;
  private timers = new Map<string, NodeJS.Timeout>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private unsubscribeIdle: (() => void) | null = null;
  private queue: Reminder[] = [];
  /** Overdue reminders awaiting the session-start pick; never auto-fired. */
  private pendingPick = new Set<string>();
  /** Reminders already logged as held, to keep the run log quiet. */
  private heldLogged = new Set<string>();
  private stopped = false;

  constructor(host: EngineHost) {
    this.host = host;
    // Busy-queue plumbing is session-lifetime, independent of start().
    this.unsubscribeIdle = this.host.onIdle(() => this.flushQueue());
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Register presence, mark overdue reminders pending-pick (never auto-fired),
   * start heartbeat/sweep/idle plumbing, and return the overdue list so the
   * caller can drive the pick UI. Must run from session_start.
   */
  start(): Reminder[] {
    const { sessionId, cwd, projectRoot } = this.host;
    updateStore((data) => {
      registerSession(data, sessionId, { pid: process.pid, cwd, project_root: projectRoot });
      return { result: null };
    });
    logEvent("session_registered", { session: sessionId, cwd, project_root: projectRoot });

    // Before any sweep can fire them: overdue reminders wait for the pick.
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

  /** Idempotent: clear timers, flush nothing, release presence + sticky claims. */
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

  // -------------------------------------------------------------------------
  // Overdue pick flow (session start)
  // -------------------------------------------------------------------------

  /**
   * Collect overdue, in-scope, claimable reminders and mark them pending-pick
   * so timers/sweeps never auto-fire them. Returns them for the picker UI.
   */
  collectOverdue(now: Date = new Date()): Reminder[] {
    const data = updateStore((d) => ({ result: d }));
    const overdue = data.reminders.filter(
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

  /**
   * User picked an overdue reminder (or ran /remind fire): force-claim it for
   * this session regardless of due time or current owner, then deliver.
   */
  fireNow(id: string): boolean {
    this.pendingPick.delete(id);
    let reminder: Reminder | null = null;
    const result = updateStore((data) => {
      const r = data.reminders.find((x) => x.id === id);
      if (!r || !r.enabled) return { result: "gone" as ClaimResult };
      reminder = this.claim(data, r, true);
      return { result: r.sticky_session_id === this.host.sessionId ? ("claimed" as ClaimResult) : ("gone" as ClaimResult) };
    });
    if (result === "gone" || !reminder) return false;
    this.deliver(reminder);
    this.armTimers();
    return true;
  }

  /** Leave an overdue reminder unfired; it stays pending-pick (snoozed) until next session start. */
  snoozeOverdue(id: string): void {
    logEvent("overdue_snoozed", { id, session: this.host.sessionId });
  }

  // -------------------------------------------------------------------------
  // Sweep + timers
  // -------------------------------------------------------------------------

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

  /** Fire every due, in-scope reminder this session may claim. Exported for tests. */
  fireDue(data?: StoreData): void {
    const store = data ?? updateStore((d) => ({ result: d }));
    const now = Date.now();
    for (const r of store.reminders) {
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
        const fresh = d.reminders.find((x) => x.id === r.id);
        if (!fresh || !fresh.enabled) return { result: "gone" as ClaimResult };
        if (Date.parse(fresh.next_fire_at) > Date.now()) return { result: "not_due" as ClaimResult };
        if (!this.claimableByMe(d, fresh)) return { result: "held" as ClaimResult };
        this.claim(d, fresh, false);
        return { result: (fresh.sticky_session_id === this.host.sessionId ? "claimed" : "gone") as ClaimResult };
      });
      if (claimed === "claimed") this.deliver(r);
    }
  }

  private claimableByMe(data: StoreData, r: Reminder): boolean {
    if (!r.sticky_session_id || r.sticky_session_id === this.host.sessionId) return true;
    return !isSessionAlive(data, r.sticky_session_id);
  }

  /**
   * Mutate the store to record this session's firing: sticky ownership moves
   * here, intervals advance (coalescing misses), one-shots are deleted.
   */
  private claim(data: StoreData, r: Reminder, force: boolean): Reminder {
    const previousOwner = r.sticky_session_id;
    const transferred = previousOwner !== null && previousOwner !== this.host.sessionId;
    const now = new Date();

    r.sticky_session_id = this.host.sessionId;
    r.last_fired_at = now.toISOString();
    if (r.schedule.type === "once") {
      data.reminders = data.reminders.filter((x) => x.id !== r.id);
    } else {
      r.next_fire_at = force && Date.parse(r.next_fire_at) > now.getTime()
        ? r.next_fire_at // manual fire of a future reminder keeps its slot
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

  /** Arm timers for future reminders this session may end up claiming. */
  private armTimers(data?: StoreData): void {
    const store = data ?? updateStore((d) => ({ result: d }));
    const live = new Set(store.reminders.map((r) => r.id));
    for (const [id, t] of this.timers) {
      if (!live.has(id)) {
        clearTimeout(t);
        this.timers.delete(id);
      }
    }
    const now = Date.now();
    for (const r of store.reminders) {
      if (!r.enabled || !inScope(r, this.host.cwd) || this.pendingPick.has(r.id)) continue;
      if (!this.claimableByMe(store, r)) continue;
      const delay = Date.parse(r.next_fire_at) - now;
      if (delay <= 0) continue; // due reminders are handled by fireDue
      if (this.timers.has(r.id)) continue;
      const timer = setTimeout(() => {
        this.timers.delete(r.id);
        this.safeSweep();
      }, Math.min(delay, MAX_TIMER_MS));
      timer.unref();
      this.timers.set(r.id, timer);
    }
  }

  // -------------------------------------------------------------------------
  // Delivery
  // -------------------------------------------------------------------------

  private deliver(r: Reminder): void {
    try {
      if (r.delivery === "notify") {
        this.host.notify(reminderText(r));
        return;
      }
      if (this.host.isBusy()) {
        this.queue.push(r);
        logEvent("deferred", { id: r.id, session: this.host.sessionId, reason: "agent busy" });
        return;
      }
      this.host.deliverPrompt(reminderText(r));
    } catch (err) {
      logEvent("error", { id: r.id, session: this.host.sessionId, message: `deliver: ${String(err)}` });
    }
  }

  private flushQueue(): void {
    const queued = this.queue.splice(0);
    for (const r of queued) {
      logEvent("deferred_flush", { id: r.id, session: this.host.sessionId });
      try {
        this.host.deliverPrompt(reminderText(r));
      } catch (err) {
        logEvent("error", { id: r.id, session: this.host.sessionId, message: `flush: ${String(err)}` });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Cross-project digest
  // -------------------------------------------------------------------------

  private emitDigest(): void {
    const data = updateStore((d) => ({ result: d }));
    const byProject = new Map<string, number>();
    for (const r of data.reminders) {
      if (!r.enabled || inScope(r, this.host.cwd)) continue;
      const key = r.project_root ?? "global";
      byProject.set(key, (byProject.get(key) ?? 0) + 1);
    }
    if (byProject.size === 0) return;
    const total = [...byProject.values()].reduce((a, b) => a + b, 0);
    const parts = [...byProject.entries()].map(([p, n]) => `${p} (${n})`).join(", ");
    logEvent("digest", { session: this.host.sessionId, count: total, projects: [...byProject.keys()] });
    this.host.notify(`⏰ ${total} pending reminder${total === 1 ? "" : "s"} in other projects: ${parts} — /remind list --all`);
  }
}
