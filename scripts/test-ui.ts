// UI component verification: task list overlay rendering and key handling, overdue
// picker semantics, widget line. Uses a fake theme/tui; drives the real store.
// Run: PI_SCHEDULER_DIR=$(mktemp -d) node scripts/test-ui.ts
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { updateStore, readStore, type ScheduledTask } from "../extensions/scheduler/store.ts";
import {
  OverduePickComponent,
  TaskListComponent,
  scopedTasks,
  widgetLines,
  type TaskHost,
} from "../extensions/scheduler/ui.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

if (!process.env.PI_SCHEDULER_DIR) {
  console.error("set PI_SCHEDULER_DIR to a scratch directory");
  process.exit(2);
}

const theme = {
  fg: (_color: string, s: string) => s,
  bg: (_color: string, s: string) => s,
  bold: (s: string) => s,
} as unknown as Theme;

const tui = { requestRender() {} } as unknown as TUI;

const CWD = process.cwd();
const future = new Date(Date.now() + 30 * 60_000).toISOString();
const past = new Date(Date.now() - 10 * 60_000).toISOString();

function makeTask(id: string, next: string, scope: "project" | "global" = "project"): ScheduledTask {
  return {
    id,
    prompt: `prompt for ${id}\nsecond line`,
    schedule: { type: "once", at: next },
    delivery: "prompt",
    scope,
    project_root: scope === "project" ? CWD : null,
    sticky_session_id: null,
    next_fire_at: next,
  };
}

// --- scopedTasks sorting/filtering ---
updateStore((d) => {
  d.tasks = [makeTask("t-late", future), makeTask("t-early", new Date(Date.now() + 60_000).toISOString())];
  return { result: null };
});
{
  const tasks = scopedTasks(false, CWD);
  check("scopedTasks sorts by next_fire_at", tasks[0]?.id === "t-early" && tasks[1]?.id === "t-late");
}

// --- TaskListComponent ---
{
  const fired: string[] = [];
  const removed: string[] = [];
  const host: TaskHost = {
    sessionId: "s-test",
    cwd: CWD,
    fire: (id) => (fired.push(id), true),
    remove: (id) => {
      removed.push(id);
      updateStore((d) => ({ result: (d.tasks = d.tasks.filter((t) => t.id !== id)) && null }));
      return null;
    },
  };
  let closed = false;
  const c = new TaskListComponent(host, tui, theme, () => (closed = true));

  const out = c.render(100).join("\n");
  check("list renders both tasks", out.includes("t-early") && out.includes("t-late"));
  check("list renders prompt one-lined", out.includes("prompt for t-early second line"));
  check("list renders footer hints", out.includes("enter fire"));
  check("list renders scope label", out.includes("this project"));

  c.handleInput("\x1b[B"); // down
  c.handleInput("\r"); // enter = fire selected (t-late)
  check("enter fires selected task", fired[0] === "t-late", fired.join(","));

  c.handleInput("d");
  c.handleInput("n"); // decline
  check("delete declined keeps task", removed.length === 0 && readStore().tasks.length === 2);
  c.handleInput("d");
  c.handleInput("y"); // confirm
  check("delete confirmed removes task", removed[0] === "t-late" && readStore().tasks.length === 1);

  c.handleInput("a");
  check("a toggles scope", c.render(100).join("\n").includes("all projects"));

  c.handleInput("\x1b"); // escape closes
  check("escape closes overlay", closed);
  c.dispose();
}

// --- OverduePickComponent ---
{
  const overdue = [makeTask("t-od1", past), makeTask("t-od2", past)];
  const picked: { ids: string[] | null } = { ids: null };
  const c = new OverduePickComponent(overdue, theme, (ids) => (picked.ids = ids));

  const out = c.render(100).join("\n");
  check("overdue renders both tasks", out.includes("t-od1") && out.includes("t-od2"));
  check("overdue marks all by default", out.includes("2/2 marked"));

  c.handleInput(" "); // unmark first
  c.handleInput("\r"); // fire marked
  check("enter fires only marked", picked.ids !== null && picked.ids.join(",") === "t-od2", String(picked.ids));

  const c2 = new OverduePickComponent(overdue, theme, (ids) => (picked.ids = ids));
  c2.handleInput("\x1b"); // escape = skip all
  check("escape skips all", picked.ids !== null && picked.ids.length === 0);
}

// --- widgetLines ---
{
  const lines = widgetLines(theme, CWD);
  check("widget shows next task", lines !== undefined && lines[0].includes("t-early"), lines?.[0]);
  updateStore((d) => ({ result: (d.tasks = []) && null }));
  check("widget hides with no tasks", widgetLines(theme, CWD) === undefined);
}

process.exit(failures === 0 ? 0 : 1);
