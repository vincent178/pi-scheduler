import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { isSessionAlive, readStore, type ScheduledTask, type StoreData } from "./store.ts";
import { inScope } from "./project.ts";
import { relTime, scheduleDesc, scopeLabel } from "./format.ts";

const IMMINENT_MS = 5 * 60_000;
const MAX_VISIBLE_TASKS = 8;

export interface TaskHost {
  sessionId: string;
  cwd: string;
  fire(id: string): boolean;
  remove(id: string): ScheduledTask | null;
}

export function scopedTasks(all: boolean, cwd: string, store: StoreData = readStore()): ScheduledTask[] {
  return store.tasks
    .filter((r) => all || inScope(r, cwd))
    .sort((a, b) => Date.parse(a.next_fire_at) - Date.parse(b.next_fire_at));
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function fireTimeLabel(r: ScheduledTask, theme: Theme, now: number): string {
  const fireMs = Date.parse(r.next_fire_at);
  const rel = relTime(r.next_fire_at, now);
  if (fireMs <= now) return theme.fg("error", theme.bold(rel));
  if (fireMs - now < IMMINENT_MS) return theme.fg("warning", rel);
  return theme.fg("accent", rel);
}

function ownerLabelThemed(r: ScheduledTask, mySession: string, store: StoreData, theme: Theme): string {
  if (!r.sticky_session_id) return theme.fg("dim", "unowned");
  if (r.sticky_session_id === mySession) return theme.fg("accent", "this session");
  const stale = isSessionAlive(store, r.sticky_session_id) ? "" : " (stale)";
  return theme.fg(stale ? "dim" : "muted", `${r.sticky_session_id.slice(0, 8)}${stale}`);
}

/** Two themed lines per task: meta row + one-line prompt, both width-clamped. */
export function taskRowLines(
  r: ScheduledTask,
  theme: Theme,
  width: number,
  mySession: string,
  store: StoreData,
  now = Date.now(),
): string[] {
  const glyph = r.schedule.type === "interval" ? "🔁" : "⏰";
  const meta = [
    `${glyph} ${fireTimeLabel(r, theme, now)}`,
    theme.fg("dim", r.id),
    theme.fg("muted", scheduleDesc(r.schedule)),
    theme.fg("muted", r.delivery),
    theme.fg("muted", scopeLabel(r)),
    ownerLabelThemed(r, mySession, store, theme),
  ].join(theme.fg("dim", "  ·  "));
  return [truncateToWidth(meta, width), truncateToWidth(`    ${oneLine(r.prompt)}`, width)];
}

function headerLine(title: string, right: string, width: number, theme: Theme): string {
  const left = `${theme.fg("borderMuted", "─".repeat(3))} ${theme.fg("accent", theme.bold(title))} `;
  const rightText = right ? `${theme.fg("muted", right)} ` : "";
  const fill = Math.max(0, width - visibleWidth(left) - visibleWidth(rightText));
  return truncateToWidth(left + theme.fg("borderMuted", "─".repeat(fill)) + rightText, width);
}

/** Interactive task manager shown by /schedule list in TUI mode. */
export class TaskListComponent implements Component {
  private readonly host: TaskHost;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly done: () => void;
  private showAll: boolean;
  private store: StoreData = { tasks: [], sessions: {} };
  private tasks: ScheduledTask[] = [];
  private selected = 0;
  private preview = false;
  private pendingDelete: string | null = null;
  private readonly tick: NodeJS.Timeout;
  private cacheWidth = -1;
  private cacheLines: string[] | null = null;

  constructor(host: TaskHost, tui: TUI, theme: Theme, done: () => void, showAll = false) {
    this.host = host;
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.showAll = showAll;
    this.refresh();
    // Re-read the store so countdowns advance and cross-session edits appear.
    this.tick = setInterval(() => {
      this.refresh();
      this.invalidate();
      this.tui.requestRender();
    }, 1000);
    this.tick.unref();
  }

  dispose(): void {
    clearInterval(this.tick);
  }

  invalidate(): void {
    this.cacheWidth = -1;
    this.cacheLines = null;
  }

  private refresh(): void {
    this.store = readStore();
    this.tasks = scopedTasks(this.showAll, this.host.cwd, this.store);
    this.selected = Math.min(this.selected, Math.max(0, this.tasks.length - 1));
    if (this.pendingDelete && !this.tasks.some((t) => t.id === this.pendingDelete)) {
      this.pendingDelete = null;
    }
  }

  handleInput(data: string): void {
    const task = this.tasks[this.selected];
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      if (this.pendingDelete) this.pendingDelete = null;
      else if (this.preview) this.preview = false;
      else {
        this.done();
        return;
      }
    } else if (this.pendingDelete) {
      if (data === "y") {
        this.host.remove(this.pendingDelete);
        this.pendingDelete = null;
        this.refresh();
      } else if (data === "n" || data === "d") {
        this.pendingDelete = null;
      }
    } else if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
      this.selected = Math.max(0, this.selected - 1);
    } else if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
      this.selected = Math.min(this.tasks.length - 1, this.selected + 1);
    } else if (data === "a") {
      this.showAll = !this.showAll;
      this.refresh();
    } else if (data === "p" && task) {
      this.preview = !this.preview;
    } else if (data === "d" && task) {
      this.pendingDelete = task.id;
    } else if ((matchesKey(data, "enter") || data === "f") && task) {
      this.host.fire(task.id);
      this.refresh();
    }
    this.invalidate();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (this.cacheLines && this.cacheWidth === width) return this.cacheLines;
    const th = this.theme;
    const scope = this.showAll ? "all projects" : "this project";
    const lines: string[] = [""];
    lines.push(headerLine(" Scheduled Tasks ", `${scope} · ${this.tasks.length} `, width, th));
    lines.push("");

    if (this.tasks.length === 0) {
      const hint = this.showAll ? "No scheduled tasks at all." : "No tasks in this project — press a to show all.";
      lines.push(truncateToWidth(`  ${th.fg("dim", hint)}`, width));
    } else {
      const start = Math.max(
        0,
        Math.min(this.selected - Math.floor(MAX_VISIBLE_TASKS / 2), this.tasks.length - MAX_VISIBLE_TASKS),
      );
      const end = Math.min(this.tasks.length, start + MAX_VISIBLE_TASKS);
      for (let i = start; i < end; i++) {
        const t = this.tasks[i];
        const isSelected = i === this.selected;
        const cursor = isSelected ? th.fg("accent", "› ") : "  ";
        const [meta, prompt] = taskRowLines(t, th, width - 2, this.host.sessionId, this.store);
        lines.push(truncateToWidth(cursor + (isSelected ? th.bold(meta) : meta), width));
        lines.push(prompt);
        if (this.pendingDelete === t.id) {
          lines.push(truncateToWidth(`      ${th.fg("error", `Delete ${t.id}? (y/n)`)}`, width));
        }
        if (isSelected && this.preview) {
          for (const w of wrapTextWithAnsi(t.prompt, Math.max(10, width - 6))) {
            lines.push(truncateToWidth(`    ${th.fg("dim", "│")} ${w}`, width));
          }
        }
      }
      if (this.tasks.length > MAX_VISIBLE_TASKS) {
        lines.push(truncateToWidth(`  ${th.fg("dim", `(${this.selected + 1}/${this.tasks.length})`)}`, width));
      }
    }

    lines.push("");
    lines.push(
      truncateToWidth(
        `  ${th.fg("dim", "↑↓ select · enter fire · d delete · p preview · a toggle scope · esc close")}`,
        width,
      ),
    );
    lines.push("");

    this.cacheWidth = width;
    this.cacheLines = lines;
    return lines;
  }
}

/** Session-start picker for overdue tasks; resolves with the ids to fire. */
export class OverduePickComponent implements Component {
  private readonly tasks: ScheduledTask[];
  private readonly theme: Theme;
  private readonly done: (fireIds: string[]) => void;
  private readonly marked = new Set<string>();
  private selected = 0;
  private cacheWidth = -1;
  private cacheLines: string[] | null = null;

  constructor(tasks: ScheduledTask[], theme: Theme, done: (fireIds: string[]) => void) {
    this.tasks = tasks;
    this.theme = theme;
    this.done = done;
    for (const t of tasks) this.marked.add(t.id);
  }

  invalidate(): void {
    this.cacheWidth = -1;
    this.cacheLines = null;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.done([]);
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
      this.selected = Math.max(0, this.selected - 1);
    } else if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
      this.selected = Math.min(this.tasks.length - 1, this.selected + 1);
    } else if (matchesKey(data, "space")) {
      const id = this.tasks[this.selected]?.id;
      if (id) this.marked.has(id) ? this.marked.delete(id) : this.marked.add(id);
    } else if (data === "a") {
      if (this.marked.size === this.tasks.length) this.marked.clear();
      else for (const t of this.tasks) this.marked.add(t.id);
    } else if (matchesKey(data, "enter")) {
      this.done(this.tasks.filter((t) => this.marked.has(t.id)).map((t) => t.id));
      return;
    }
    this.invalidate();
  }

  render(width: number): string[] {
    if (this.cacheLines && this.cacheWidth === width) return this.cacheLines;
    const th = this.theme;
    const lines: string[] = [""];
    lines.push(headerLine(" Overdue Tasks ", `${this.marked.size}/${this.tasks.length} marked `, width, th));
    lines.push("");
    const now = Date.now();
    for (let i = 0; i < this.tasks.length; i++) {
      const t = this.tasks[i];
      const isSelected = i === this.selected;
      const box = this.marked.has(t.id) ? th.fg("success", "[x]") : th.fg("dim", "[ ]");
      const cursor = isSelected ? th.fg("accent", "› ") : "  ";
      const due = th.fg("error", `was due ${new Date(t.next_fire_at).toLocaleString()} (${relTime(t.next_fire_at, now)})`);
      lines.push(truncateToWidth(`${cursor}${box} ${th.fg("dim", t.id)}  ${due}`, width));
      lines.push(truncateToWidth(`      ${oneLine(t.prompt)}`, width));
    }
    lines.push("");
    lines.push(
      truncateToWidth(
        `  ${th.fg("dim", "↑↓ select · space toggle · a toggle all · enter fire marked · esc skip all")}`,
        width,
      ),
    );
    lines.push("");
    this.cacheWidth = width;
    this.cacheLines = lines;
    return lines;
  }
}

/** One-line widget content for ctx.ui.setWidget; undefined hides the widget. */
export function widgetLines(theme: Theme, cwd: string): string[] | undefined {
  const tasks = scopedTasks(false, cwd);
  if (tasks.length === 0) return undefined;
  const next = tasks[0];
  const summary = truncateToWidth(oneLine(next.prompt), 50);
  const count = tasks.length > 1 ? theme.fg("dim", ` · ${tasks.length} tasks`) : "";
  return [
    `⏰ ${fireTimeLabel(next, theme, Date.now())} ${theme.fg("muted", summary)}${count} ${theme.fg("dim", "· /schedule list")}`,
  ];
}
