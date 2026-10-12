import * as chrono from "chrono-node";
import type { Schedule } from "./store.ts";

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

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

/**
 * Parse a natural-language schedule into a Schedule.
 *
 * - "every 45 minutes", "every 2h", "every day"   -> interval
 * - "in 30m", "at 15:00", "tomorrow at 9am", ISO  -> once (chrono-node)
 *
 * Throws Error with a usage hint when the input matches neither form.
 */
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
  if (results.length > 0) {
    // Strict: the matches must span the whole input, so "in 30m check the"
    // is not accepted as a schedule (chrono finds dates anywhere in text).
    const trimmedEnd = normalized.trimEnd().length;
    const first = results[0];
    const last = results[results.length - 1];
    const covers = first.index === 0 && last.index + last.text.length >= trimmedEnd;
    const date = (last.end ?? last.start).date();
    if (covers && date.getTime() > now.getTime()) {
      return { type: "once", at: date.toISOString() };
    }
  }

  throw new Error(
    `could not parse schedule: "${input}". Try "in 30m", "at 15:00", "tomorrow at 9am", "every 45 minutes", or an ISO date.`,
  );
}

// ---------------------------------------------------------------------------
// next_fire_at computation
// ---------------------------------------------------------------------------

/** First fire time for a freshly created task. */
export function initialNextFire(schedule: Schedule, now: Date = new Date()): string {
  if (schedule.type === "once") return schedule.at;
  return new Date(now.getTime() + schedule.every_minutes * 60_000).toISOString();
}

/**
 * Next fire time after a firing. Returns null for one-shot schedules (caller
 * deletes them). Interval schedules coalesce missed intervals: the result is
 * always the first slot strictly in the future.
 */
export function advanceNextFire(schedule: Schedule, now: Date = new Date()): string | null {
  if (schedule.type === "once") return null;
  const stepMs = schedule.every_minutes * 60_000;
  let next = now.getTime() + stepMs;
  return new Date(next).toISOString();
}

/**
 * Coalesce overdue intervals: given a task whose next_fire_at is in the
 * past, return how many intervals were missed (>= 1 means overdue).
 */
export function missedIntervals(schedule: Schedule, nextFireAt: string, now: Date = new Date()): number {
  if (schedule.type !== "interval") return Date.parse(nextFireAt) <= now.getTime() ? 1 : 0;
  const stepMs = schedule.every_minutes * 60_000;
  const overdue = now.getTime() - Date.parse(nextFireAt);
  if (overdue < 0) return 0;
  return Math.floor(overdue / stepMs) + 1;
}
