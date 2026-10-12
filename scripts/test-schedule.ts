// Schedule parsing verification. Run: node scripts/test-schedule.ts
import {
  parseSchedule,
  initialNextFire,
  advanceNextFire,
  missedIntervals,
} from "../extensions/scheduler/schedule.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// Fixed reference: Wednesday 2026-01-07 10:00:00 local time.
const now = new Date(2026, 0, 7, 10, 0, 0);
const M = 60_000;

// --- intervals ---------------------------------------------------------------
for (const [input, minutes] of [
  ["every 45 minutes", 45],
  ["every 2 hours", 120],
  ["every 2h", 120],
  ["every 30m", 30],
  ["every minute", 1],
  ["every day", 1440],
  ["every 90 seconds", 2],
] as const) {
  const s = parseSchedule(input, now);
  check(
    `"${input}" -> interval ${minutes}m`,
    s.type === "interval" && s.every_minutes === minutes,
    JSON.stringify(s),
  );
}

// --- one-shot -----------------------------------------------------------------
const in30 = parseSchedule("in 30m", now);
check(
  '"in 30m" -> once 30 minutes ahead',
  in30.type === "once" && Date.parse(in30.at) === now.getTime() + 30 * M,
  JSON.stringify(in30),
);

const in2h = parseSchedule("in 2 hours", now);
check(
  '"in 2 hours" -> once 2 hours ahead',
  in2h.type === "once" && Date.parse(in2h.at) === now.getTime() + 120 * M,
  JSON.stringify(in2h),
);

// "at 15:00" from 10:00 -> today 15:00
const at15 = parseSchedule("at 15:00", now);
check(
  '"at 15:00" (now=10:00) -> today 15:00',
  at15.type === "once" && Date.parse(at15.at) === new Date(2026, 0, 7, 15, 0, 0).getTime(),
  JSON.stringify(at15),
);

// "at 15:00" from 16:00 -> tomorrow 15:00 (past-time rollover)
const evening = new Date(2026, 0, 7, 16, 0, 0);
const at15Late = parseSchedule("at 15:00", evening);
check(
  '"at 15:00" (now=16:00) -> next-day rollover',
  at15Late.type === "once" && Date.parse(at15Late.at) === new Date(2026, 0, 8, 15, 0, 0).getTime(),
  JSON.stringify(at15Late),
);

const iso = parseSchedule("2026-12-25T09:00:00", now);
check(
  "ISO date -> once at that instant",
  iso.type === "once" && Date.parse(iso.at) === new Date(2026, 11, 25, 9, 0, 0).getTime(),
  JSON.stringify(iso),
);

const tomorrow9 = parseSchedule("tomorrow at 9am", now);
check(
  '"tomorrow at 9am" -> next day 09:00',
  tomorrow9.type === "once" && Date.parse(tomorrow9.at) === new Date(2026, 0, 8, 9, 0, 0).getTime(),
  JSON.stringify(tomorrow9),
);

// past one-shot inputs must not silently schedule in the past
let threw = false;
try {
  parseSchedule("2020-01-01T00:00:00", now);
} catch {
  threw = true;
}
check("past ISO date throws", threw);

threw = false;
try {
  parseSchedule("whenever you feel like it", now);
} catch {
  threw = true;
}
check("unparseable input throws with usage hint", threw);

threw = false;
try {
  parseSchedule("every 10 seconds", now);
} catch {
  threw = true;
}
check("sub-minute interval rejected", threw);

// --- next_fire_at --------------------------------------------------------------
const onceAt = initialNextFire({ type: "once", at: "2026-01-08T09:00:00.000Z" }, now);
check("initialNextFire(once) echoes at", onceAt === "2026-01-08T09:00:00.000Z");

const interval = { type: "interval", every_minutes: 45 } as const;
const first = initialNextFire(interval, now);
check(
  "initialNextFire(interval) = now + 45m",
  Date.parse(first) === now.getTime() + 45 * M,
);

check("advanceNextFire(once) -> null (caller deletes)", advanceNextFire({ type: "once", at: onceAt }, now) === null);

const next = advanceNextFire(interval, now);
check("advanceNextFire(interval) = now + 45m", next !== null && Date.parse(next) === now.getTime() + 45 * M);

// missed intervals: next_fire_at 4.5 intervals in the past -> 5 missed
const missedFrom = new Date(now.getTime() - 4.5 * 45 * M).toISOString();
check(
  "missedIntervals coalesces 5 missed slots",
  missedIntervals(interval, missedFrom, now) === 5,
  `got ${missedIntervals(interval, missedFrom, now)}`,
);
check("missedIntervals -> 0 when not due", missedIntervals(interval, first, now) === 0);
const onceAt2 = new Date(now.getTime() - M).toISOString();
check(
  "missedIntervals(once) -> 1 when overdue",
  missedIntervals({ type: "once", at: onceAt2 }, onceAt2, now) === 1,
);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
