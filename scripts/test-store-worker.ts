// Worker: performs store mutations against PI_SCHEDULER_DIR. Invoked by test-store.ts.
import {
  updateStore,
  registerSession,
  heartbeat,
  deregisterSession,
  newTaskId,
  logEvent,
} from "../extensions/scheduler/store.ts";

const sessionId = process.argv[2];
const iterations = Number(process.argv[3]);

if (!sessionId || !iterations) {
  console.error("usage: test-store-worker.ts <sessionId> <iterations>");
  process.exit(2);
}

updateStore((data) => {
  registerSession(data, sessionId, { pid: process.pid, cwd: "/tmp", project_root: "/tmp" });
  return { result: null };
});

for (let i = 0; i < iterations; i++) {
  updateStore((data) => {
    const counters = (data as unknown as { counters?: Record<string, number> });
    counters.counters ??= {};
    counters.counters.total = (counters.counters.total ?? 0) + 1;
    heartbeat(data, sessionId);
    return { result: null };
  });
  if (i % 5 === 0) {
    const id = newTaskId();
    updateStore((data) => {
      data.tasks.push({
        id,
        prompt: `worker ${sessionId} task ${i}`,
        schedule: { type: "interval", every_minutes: 30 },
        delivery: "prompt",
        scope: "project",
        project_root: "/tmp",
        sticky_session_id: sessionId,
        created_at: new Date().toISOString(),
        next_fire_at: new Date().toISOString(),
        last_fired_at: null,
        enabled: true,
      });
      return { result: null };
    });
    logEvent("created", { id, session: sessionId });
  }
}

const released = updateStore((data) => ({ result: deregisterSession(data, sessionId) }));
logEvent("worker_done", { session: sessionId, released: released.length });
console.log(`${sessionId}: done, released=${released.length}`);
