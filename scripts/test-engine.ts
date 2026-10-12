// Engine verification with two simulated sessions sharing one store.
// Run: PI_REMINDER_DIR=$(mktemp -d) node scripts/test-engine.ts
import {
  readStore,
  updateStore,
  registerSession,
  newReminderId,
  type Reminder,
} from "../extensions/reminder/store.ts";
import { Engine, type EngineHost } from "../extensions/reminder/engine.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

if (!process.env.PI_REMINDER_DIR) {
  console.error("set PI_REMINDER_DIR to a scratch directory");
  process.exit(2);
}

interface MockHost extends EngineHost {
  prompts: string[];
  notifies: string[];
  busy: boolean;
  idle(): void;
}

function mockHost(sessionId: string, cwd: string): MockHost {
  const idleCbs: (() => void)[] = [];
  const host: MockHost = {
    sessionId,
    cwd,
    projectRoot: cwd,
    prompts: [],
    notifies: [],
    busy: false,
    deliverPrompt(text) {
      host.prompts.push(text);
    },
    notify(text) {
      host.notifies.push(text);
    },
    isBusy() {
      return host.busy;
    },
    onIdle(cb) {
      idleCbs.push(cb);
      return () => {};
    },
    idle() {
      for (const cb of idleCbs) cb();
    },
  };
  return host;
}

function addReminder(overrides: Partial<Reminder>): Reminder {
  const r: Reminder = {
    id: newReminderId(),
    prompt: "test reminder",
    schedule: { type: "interval", every_minutes: 30 },
    delivery: "prompt",
    scope: "project",
    project_root: "/proj",
    sticky_session_id: null,
    created_at: new Date().toISOString(),
    next_fire_at: new Date(Date.now() - 1000).toISOString(), // already due
    last_fired_at: null,
    enabled: true,
    ...overrides,
  };
  updateStore((data) => {
    data.reminders.push(r);
    return { result: null };
  });
  return r;
}

const hostA = mockHost("session-A", "/proj");
const hostB = mockHost("session-B", "/proj");

// Presence: both sessions alive without starting full engines (no timers in tests).
updateStore((data) => {
  registerSession(data, "session-A", { pid: 111, cwd: "/proj", project_root: "/proj" });
  registerSession(data, "session-B", { pid: 222, cwd: "/proj", project_root: "/proj" });
  return { result: null };
});

const engineA = new Engine(hostA);
const engineB = new Engine(hostB);

// --- 1. unowned due reminder: first session to fire claims stickiness ---------
const r1 = addReminder({});
engineA.fireDue();
check("A fires unowned due reminder", hostA.prompts.length === 1, hostA.prompts[0]);
let store = readStore();
check("firing sets sticky_session_id to A", store.reminders[0]?.sticky_session_id === "session-A");
check("interval next_fire_at advanced into the future", Date.parse(store.reminders[0].next_fire_at) > Date.now());

// --- 2. same reminder not due elsewhere: B cannot fire it ----------------------
engineB.fireDue();
check("B does not double-fire (not due)", hostB.prompts.length === 0);

// --- 3. when due again, live sticky owner holds it ----------------------------
updateStore((data) => {
  data.reminders[0].next_fire_at = new Date(Date.now() - 1000).toISOString();
  return { result: null };
});
engineB.fireDue();
check("B held while A alive (sticky_held)", hostB.prompts.length === 0);
engineA.fireDue();
check("owner A fires its own reminder", hostA.prompts.length === 2);

// --- 4. stale owner -> ownership transfers to the next claimer ------------------
updateStore((data) => {
  data.reminders[0].next_fire_at = new Date(Date.now() - 1000).toISOString();
  data.sessions["session-A"].heartbeat_at = new Date(Date.now() - 10 * 60_000).toISOString();
  return { result: null };
});
engineB.fireDue();
store = readStore();
check("B fires after A goes stale", hostB.prompts.length === 1);
check("stickiness transferred to B", store.reminders[0]?.sticky_session_id === "session-B");

// --- 5. racing claims: exactly one session fires -------------------------------
const r2 = addReminder({ prompt: "race target" });
// simulate a race: B claims first inside the same tick A would have used
engineA.fireDue();
engineB.fireDue();
const raceFires = hostA.prompts.filter((p) => p.includes("race target")).length +
  hostB.prompts.filter((p) => p.includes("race target")).length;
check("racing sessions fire exactly once", raceFires === 1, `fires=${raceFires}`);

// --- 6. one-shot reminders are deleted after firing ------------------------------
const r3 = addReminder({ prompt: "one shot", schedule: { type: "once", at: new Date(Date.now() - 1000).toISOString() } });
engineA.fireDue();
store = readStore();
check("one-shot fired", hostA.prompts.some((p) => p.includes("one shot")));
check("one-shot deleted after firing", !store.reminders.some((r) => r.id === r3.id));

// --- 7. busy queue: prompt queued while busy, flushed on idle --------------------
const r4 = addReminder({ prompt: "busy test", sticky_session_id: "session-B" });
hostB.busy = true;
engineB.fireDue();
check("prompt not delivered while busy", !hostB.prompts.some((p) => p.includes("busy test")));
hostB.busy = false;
hostB.idle();
check("queued prompt flushed on idle", hostB.prompts.some((p) => p.includes("busy test")));

// --- 8. notify delivery fires immediately even while busy -------------------------
const r5 = addReminder({ prompt: "notify test", delivery: "notify", sticky_session_id: "session-B" });
hostB.busy = true;
engineB.fireDue();
check("notify delivered while busy", hostB.notifies.some((n) => n.includes("notify test")));
hostB.busy = false;

// --- 9. scope: reminder for another project is invisible ---------------------------
const r6 = addReminder({ prompt: "foreign project", project_root: "/other" });
engineA.fireDue();
engineB.fireDue();
check("out-of-scope reminder never fires", !hostA.prompts.concat(hostB.prompts).some((p) => p.includes("foreign project")));
store = readStore();
check("out-of-scope reminder untouched", store.reminders.some((r) => r.id === r6.id && r.last_fired_at === null));

// --- 10. overdue pick flow: pending reminders never auto-fire ----------------------
const engineC = new Engine(mockHost("session-C", "/proj"));
updateStore((data) => {
  registerSession(data, "session-C", { pid: 333, cwd: "/proj", project_root: "/proj" });
  return { result: null };
});
const r7 = addReminder({ prompt: "overdue pick me", next_fire_at: new Date(Date.now() - 3_600_000).toISOString() });
const overdue = engineC.collectOverdue();
check("collectOverdue lists due claimable reminders", overdue.some((r) => r.id === r7.id));
engineC.fireDue();
check("pending-pick reminder not auto-fired by fireDue", !engineC["host"].prompts.some((p) => p.includes("overdue pick me")));
const fired = engineC.fireNow(r7.id);
check("fireNow delivers picked reminder", fired && engineC["host"].prompts.some((p) => p.includes("overdue pick me")));
store = readStore();
check("picking transfers stickiness", store.reminders.find((r) => r.id === r7.id)?.sticky_session_id === "session-C");
engineC.snoozeOverdue("nonexistent"); // must not throw
check("snooze is safe for unknown ids", true);

// --- 11. shutdown releases sticky claims --------------------------------------------
const engineD = new Engine(mockHost("session-D", "/proj"));
engineD.start();
store = readStore();
check("start registers session presence", "session-D" in store.sessions);
updateStore((data) => {
  const r = data.reminders.find((x) => x.id === r6.id)!;
  r.sticky_session_id = "session-D";
  return { result: null };
});
engineD.shutdown();
engineD.shutdown(); // idempotent
store = readStore();
check("shutdown deregisters session", !("session-D" in store.sessions));
check(
  "shutdown releases sticky claims",
  store.reminders.find((r) => r.id === r6.id)?.sticky_session_id === null,
);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
