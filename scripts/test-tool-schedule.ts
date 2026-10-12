// Tool schedule-params verification. Run: node scripts/test-tool-schedule.ts
import { resolveTaskSchedule } from "../extensions/scheduler/schedule.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// Fixed reference: Wednesday 2026-01-07 10:00:00 local time.
const now = new Date(2026, 0, 7, 10, 0, 0);
const M = 60_000;

// delay
for (const [delay, minutes] of [
  ["24h", 24 * 60],
  ["in 24h", 24 * 60],
  ["30m", 30],
  ["2 days", 2 * 1440],
  ["2 hours", 120],
] as const) {
  const s = resolveTaskSchedule({ delay }, now);
  check(
    `delay "${delay}" -> once ${minutes}m ahead`,
    s.type === "once" && Date.parse(s.at) === now.getTime() + minutes * M,
    JSON.stringify(s),
  );
}

// every
for (const [every, minutes] of [
  ["45m", 45],
  ["every 45m", 45],
  ["1h", 60],
  ["30 minutes", 30],
] as const) {
  const s = resolveTaskSchedule({ every }, now);
  check(
    `every "${every}" -> interval ${minutes}m`,
    s.type === "interval" && s.every_minutes === minutes,
    JSON.stringify(s),
  );
}

// at
{
  const at = new Date(now.getTime() + 24 * 60 * M).toISOString();
  const s = resolveTaskSchedule({ at }, now);
  check('at (ISO) -> once at that time', s.type === "once" && s.at === at, JSON.stringify(s));
}

// errors
function throws(name: string, fn: () => unknown, match: string): void {
  try {
    fn();
    check(name, false, "did not throw");
  } catch (err) {
    check(name, (err as Error).message.includes(match), (err as Error).message);
  }
}

throws("no field -> error", () => resolveTaskSchedule({}, now), "exactly one");
throws("two fields -> error", () => resolveTaskSchedule({ delay: "1h", every: "1h" }, now), "exactly one");
{
  const s = resolveTaskSchedule({ at: "  ", delay: "1h" }, now);
  check(
    "blank field counts as unset",
    s.type === "once" && Date.parse(s.at) === now.getTime() + 60 * M,
    JSON.stringify(s),
  );
}
throws("garbage at -> error", () => resolveTaskSchedule({ at: "not-a-date" }, now), "invalid datetime");
throws("past at -> error", () => resolveTaskSchedule({ at: new Date(now.getTime() - M).toISOString() }, now), "in the past");
throws("garbage delay -> error", () => resolveTaskSchedule({ delay: "whenever" }, now), "could not parse schedule");
throws("sub-minute every -> error", () => resolveTaskSchedule({ every: "10s" }, now), "interval too small");

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
