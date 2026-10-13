// End-to-end TUI verification: runs `pi -e .` in a pty (via script(1), no extra
// deps), types "/schedule list", captures the rendered screen, and asserts the
// inline task panel appears. Timing is sleep-based; keep waits generous.
// Run: PI_SCHEDULER_DIR=$(mktemp -d) node scripts/test-e2e.ts
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const dir = process.env.PI_SCHEDULER_DIR;
if (!dir) {
  console.error("set PI_SCHEDULER_DIR to a scratch directory");
  process.exit(2);
}

const future = new Date(Date.now() + 30 * 60_000).toISOString();
fs.writeFileSync(
  path.join(dir, "scheduler.json"),
  JSON.stringify({
    tasks: [
      {
        id: "t-e2e0001",
        prompt: "e2e panel test task",
        schedule: { type: "once", at: future },
        delivery: "prompt",
        scope: "project",
        project_root: process.cwd(),
        sticky_session_id: null,
        next_fire_at: future,
      },
    ],
    sessions: {},
  }),
);

// -ne disables the installed package copy (its tools would conflict with -e .);
// explicit -e paths still load. `cat |` gives script(1) a real pipe for stdin:
// it does tcgetattr on stdin and fails outright on Node's socketpair stdio.
const args =
  process.platform === "darwin"
    ? ["-c", "cat | script -q /dev/null pi -ne -e ."]
    : ["-c", 'cat | script -qec "pi -ne -e ." /dev/null'];
const child = spawn("sh", args, {
  cwd: process.cwd(),
  detached: true, // own process group, so the watchdog can kill script+pi too
  env: { ...process.env, PI_SKIP_VERSION_CHECK: "1", TERM: "xterm-256color" },
});

let output = "";
child.stdout.on("data", (chunk) => (output += chunk.toString()));
child.stderr.on("data", (chunk) => (output += chunk.toString()));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const killTree = () => {
  try {
    process.kill(-child.pid!, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
};

const watchdog = setTimeout(() => {
  console.error("FAIL  watchdog: pi did not render the panel in time");
  killTree();
  process.exit(1);
}, 60_000);

await sleep(8_000); // pi boot
child.stdin.write("/schedule list");
await sleep(1_000);
child.stdin.write("\r");
await sleep(3_000); // panel render
child.stdin.write("\x1b"); // close panel
await sleep(500);
child.stdin.write("\x04"); // ctrl+d exits with empty editor
await sleep(1_000);
clearTimeout(watchdog);
killTree();

const stripped = output.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
check("panel title rendered", stripped.includes("Scheduled Tasks"));
check("seeded task listed", stripped.includes("t-e2e0001"));
check("scope shown", stripped.includes("this project"));
check("footer hints shown", stripped.includes("enter fire"));
check("full-width rule line", /^─{20,}$/m.test(stripped));

process.exit(failures === 0 ? 0 : 1);
