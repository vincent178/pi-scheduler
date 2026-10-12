import * as chrono from "chrono-node";
import type { Schedule } from "./store.ts";

const UNITS: Record<string, number> = {
  s: 1 / 60,
  sec: 1 / 60,
  secs: 1 / 60,
  second: 1 / 60,
  seconds: 1 / 60,
  m: 1,
  min: 1,
  mins: 1,
  minute: 1,
  minutes: 1,
  h: 60,
  hr: 60,
  hrs: 60,
  hour: 60,
  hours: 60,
  d: 1440,
  day: 1440,
  days: 1440,
};

const EVERY_RE = /^every\s+(?:(\d+(?:\.\d+)?)\s*)?([a-z]+)$/i;
const RELATIVE_SHORTHAND_RE = /^in\s+(\d+(?:\.\d+)?)\s*([smhd])$/i;

export function parseSchedule(input: string, now: Date = new Date()): Schedule {
  const text = input.trim();

  const every = EVERY_RE.exec(text);
  if (every) {
    const amount = every[1] ? Number(every[1]) : 1;
    const unit = UNITS[every[2].toLowerCase()];
    if (unit && amount > 0) {
      const minutes = amount * unit;
      if (minutes < 1) throw new Error(`interval too small: "${input}" (minimum is 1 minute)`);
      return { type: "interval", every_minutes: Math.round(minutes) };
    }
  }

  // chrono understands "in 30 minutes" but not the "in 30m" shorthand.
  const shorthand = RELATIVE_SHORTHAND_RE.exec(text);
  const normalized = shorthand
    ? `in ${shorthand[1]} ${UNITS[shorthand[2]] === 1 ? "minutes" : shorthand[2] === "s" ? "seconds" : shorthand[2] === "h" ? "hours" : "days"}`
    : text;

  const results = chrono.parse(normalized, now, { forwardDate: true });
  // chrono finds dates anywhere in text; accept only a single result spanning
  // the whole input, so "in 30m check the" or "tomorrow at 9am call him at 5pm"
  // are not accepted as schedules.
  if (results.length === 1) {
    const r = results[0];
    const covers = r.index === 0 && r.index + r.text.length >= normalized.trimEnd().length;
    const date = (r.end ?? r.start).date();
    if (covers && date.getTime() > now.getTime()) {
      return { type: "once", at: date.toISOString() };
    }
  }

  throw new Error(
    `could not parse schedule: "${input}". Try "in 30m", "at 15:00", "tomorrow at 9am", "every 45 minutes", or an ISO date.`,
  );
}

export interface TaskScheduleParams {
  at?: string;
  delay?: string;
  every?: string;
}

// Structured counterpart to parseSchedule for the agent tool: the model has
// already done the language understanding, so only one field is accepted.
export function resolveTaskSchedule(params: TaskScheduleParams, now: Date = new Date()): Schedule {
  const at = params.at?.trim();
  const delay = params.delay?.trim().replace(/^in\s+/i, "");
  const every = params.every?.trim().replace(/^every\s+/i, "");
  const set = [at, delay, every].filter(Boolean).length;
  if (set !== 1) throw new Error('exactly one of "at", "delay", or "every" is required');
  if (at) {
    const ms = Date.parse(at);
    if (Number.isNaN(ms)) throw new Error(`invalid datetime: "${at}" (use ISO 8601)`);
    if (ms <= now.getTime()) throw new Error(`"at" is in the past: "${at}"`);
    return { type: "once", at: new Date(ms).toISOString() };
  }
  return parseSchedule(delay ? `in ${delay}` : `every ${every}`, now);
}

export function initialNextFire(schedule: Schedule, now: Date = new Date()): string {
  if (schedule.type === "once") return schedule.at;
  return new Date(now.getTime() + schedule.every_minutes * 60_000).toISOString();
}

/** Null for one-shots (the caller deletes them). */
export function advanceNextFire(schedule: Schedule, now: Date = new Date()): string | null {
  if (schedule.type === "once") return null;
  const stepMs = schedule.every_minutes * 60_000;
  let next = now.getTime() + stepMs;
  return new Date(next).toISOString();
}
