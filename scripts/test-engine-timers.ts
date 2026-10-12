// Real-timer firing test: start an engine, add a task due in ~3s, expect delivery.
// Run: PI_SCHEDULER_DIR=$(mktemp -d) node scripts/test-engine-timers.ts
import { updateStore, newTaskId, readStore } from "../extensions/scheduler/store.ts";
import { Engine, type EngineHost } from "../extensions/scheduler/engine.ts";

if (!process.env.PI_SCHEDULER_DIR) {
  console.error("set PI_SCHEDULER_DIR to a scratch directory");
  process.exit(2);
}

const prompts: string[] = [];
const notifies: string[] = [];
const host: EngineHost = {
  sessionId: "timer-test",
  cwd: "/proj",
  projectRoot: "/proj",
  deliverPrompt: (t) => prompts.push(t),
  notify: (t) => notifies.push(t),
  isBusy: () => false,
  onIdle: () => () => {},
};

const engine = new Engine(host);
engine.start();

// task due in 3 seconds, created after start (like /schedule add + sweep)
updateStore((data) => {
  data.tasks.push({
    id: newTaskId(),
    prompt: "timer fire test",
    schedule: { type: "once", at: new Date(Date.now() + 3000).toISOString() },
    delivery: "prompt",
    scope: "project",
    project_root: "/proj",
    sticky_session_id: "timer-test",
    next_fire_at: new Date(Date.now() + 3000).toISOString(),
  });
  return { result: null };
});
engine.sweep(); // arm the timer, same as /schedule add does

setTimeout(() => {
  const store = readStore();
  const fired = prompts.some((p) => p.includes("timer fire test"));
  console.log(fired ? "PASS  armed timer fired and delivered" : "FAIL  no delivery");
  console.log(`      prompts=${JSON.stringify(prompts)} store.tasks=${store.tasks.length}`);
  engine.shutdown();
  process.exit(fired ? 0 : 1);
}, 6000);
