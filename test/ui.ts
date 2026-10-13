// UI component verification: task list overlay rendering and key handling, overdue
// picker semantics, widget line. Uses a fake theme/tui; drives the real store.
// Run: PI_SCHEDULER_DIR=$(mktemp -d) node test/ui.ts
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { updateStore, readStore, type ScheduledTask } from "../extensions/scheduler/store.ts";
import {
  OverduePickComponent,
  TaskListComponent,
  scopedTasks,
  widgetLines,
  widgetTickMs,
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

// Input renders its first placeholder char wrapped in a fake-cursor ANSI sequence.
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;\x07/g, "");

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
  c.focused = true;

  const out = c.render(100).join("\n");
  check("list renders both tasks", out.includes("t-early") && out.includes("t-late"));
  check("list renders prompt in description", out.includes("prompt for t-early second line"));
  check("list renders footer hints", out.includes("enter fire"));
  check("list renders scope label", out.includes("this project"));
  check("list renders filter input", stripAnsi(out).includes("filter tasks"));

  c.handleInput("\x1b[B"); // down
  c.handleInput("\r"); // enter = fire selected (t-late)
  check("enter fires selected task", fired[0] === "t-late", fired.join(","));

  c.handleInput("\x04"); // ctrl+d arms delete
  check("ctrl+d arms delete confirm", c.render(100).join("\n").includes("ctrl+d again to delete"));
  c.handleInput("x"); // typing disarms and goes to filter
  check("typing disarms delete", !c.render(100).join("\n").includes("ctrl+d again to delete"));
  c.handleInput(""); // backspace clears filter
  c.handleInput("\x04");
  c.handleInput("\x04"); // second ctrl+d confirms
  check("ctrl+d twice deletes task", removed.length === 1 && readStore().tasks.length === 1, removed.join(","));

  c.handleInput("\x01"); // ctrl+a toggles scope
  check("ctrl+a toggles scope", c.render(100).join("\n").includes("all projects"));

  c.handleInput("late"); // filter text
  check("filter narrows list", !c.render(100).join("\n").includes("t-early"));

  c.handleInput("\x1b"); // escape closes
  check("escape closes panel", closed);
}

// --- out-of-scope fire guard (all-projects view must not fire foreign tasks) ---
{
  updateStore((d) => {
    d.tasks = [makeTask("t-local", future), { ...makeTask("t-foreign", future), project_root: "/other/project" }];
    return { result: null };
  });
  const fired: string[] = [];
  const host: TaskHost = {
    sessionId: "s-test",
    cwd: CWD,
    fire: (id) => (fired.push(id), true),
    remove: () => null,
  };
  const c = new TaskListComponent(host, tui, theme, () => {}, true); // showAll
  c.focused = true;
  c.handleInput("\x1b[B"); // down to t-foreign
  c.handleInput("\r");
  check("out-of-scope task cannot be fired", fired.length === 0);
  check("notice explains the block", c.render(100).join("\n").includes("belongs to /other/project"));
  c.handleInput("\x1b[A"); // up to t-local
  c.handleInput("\r");
  check("in-scope task still fires", fired[0] === "t-local", fired.join(","));
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
  check("widget shows next task", lines !== undefined && lines[0].includes("t-local"), lines?.[0]);
  updateStore((d) => ({ result: (d.tasks = []) && null }));
  check("widget hides with no tasks", widgetLines(theme, CWD) === undefined);
}

{
  const now = Date.now();
  check("tick 30s when no tasks", widgetTickMs(null, now) === 30_000);
  check("tick 30s beyond live window", widgetTickMs(now + 2 * 60_000 + 1, now) === 30_000);
  check("tick 1s at live window boundary", widgetTickMs(now + 2 * 60_000, now) === 1_000);
  check("tick 1s inside live window", widgetTickMs(now + 42_000, now) === 1_000);
  check("tick 1s when overdue", widgetTickMs(now - 5_000, now) === 1_000);
}

process.exit(failures === 0 ? 0 : 1);
