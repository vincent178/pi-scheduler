import { isSessionAlive, type ScheduledTask, type Schedule, type StoreData } from "./store.ts";

export function relTime(iso: string, now = Date.now()): string {
  const diff = Date.parse(iso) - now;
  const abs = Math.abs(diff);
  const unit =
    abs < 60_000 ? `${Math.round(abs / 1000)}s`
    : abs < 3_600_000 ? `${Math.round(abs / 60_000)}m`
    : abs < 86_400_000 ? `${Math.round(abs / 3_600_000)}h`
    : `${Math.round(abs / 86_400_000)}d`;
  return diff >= 0 ? `in ${unit}` : `${unit} ago`;
}

export function scheduleDesc(s: Schedule): string {
  return s.type === "once" ? `once at ${new Date(s.at).toLocaleString()}` : `every ${s.every_minutes}m`;
}

export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-6)}` : id;
}

export function ownerLabel(r: ScheduledTask, mySession: string, store: StoreData): string {
  if (!r.sticky_session_id) return "unowned";
  if (r.sticky_session_id === mySession) return "this session";
  return `${shortId(r.sticky_session_id)}${isSessionAlive(store, r.sticky_session_id) ? "" : " (stale)"}`;
}

export function scopeLabel(r: ScheduledTask): string {
  return r.scope === "global" ? "global" : `project:${r.project_root ?? "?"}`;
}

/** Plain-text two-line task summary; the model-facing form used by tools and non-TUI output. */
export function formatScheduledTask(r: ScheduledTask, mySession: string, store: StoreData): string {
  return `${r.id}  ${relTime(r.next_fire_at)}  [${scheduleDesc(r.schedule)}]  ${r.delivery}  ${scopeLabel(r)}  owner:${ownerLabel(r, mySession, store)}\n    ${r.prompt}`;
}
