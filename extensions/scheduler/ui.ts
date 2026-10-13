import {
  Input,
  matchesKey,
  SelectList,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type SelectItem,
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

export function nextFireAt(cwd: string): number | null {
  const next = scopedTasks(false, cwd)[0];
  return next ? Date.parse(next.next_fire_at) : null;
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

function rule(width: number, theme: Theme): string {
  return theme.fg("accent", "─".repeat(width));
}

function selectTheme(theme: Theme) {
  return {
    selectedPrefix: (text: string) => theme.fg("accent", text),
    selectedText: (text: string) => theme.fg("accent", text),
    description: (text: string) => theme.fg("muted", text),
    scrollInfo: (text: string) => theme.fg("dim", text),
    noMatch: (text: string) => theme.fg("warning", text),
  };
}

function taskSelectItem(r: ScheduledTask, mySession: string, store: StoreData): SelectItem {
  const glyph = r.schedule.type === "interval" ? "🔁" : "⏰";
  const owner =
    !r.sticky_session_id ? "unowned" : r.sticky_session_id === mySession ? "this session" : "other session";
  return {
    value: r.id,
    label: `${glyph} ${relTime(r.next_fire_at)} · ${r.id}`,
    description: `${oneLine(r.prompt)} — ${r.delivery} · ${scopeLabel(r)} · ${owner}`,
  };
}

/**
 * Interactive task manager shown by /schedule list in TUI mode. Inline panel in
 * the style of pi's selectors: filter input, searchable list, ctrl-key actions.
 */
export class TaskListComponent implements Component {
  private readonly host: TaskHost;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly done: () => void;
  private showAll: boolean;
  private store: StoreData = { tasks: [], sessions: {} };
  private tasks: ScheduledTask[] = [];
  private readonly input: Input;
  private list: SelectList;
  private preview = false;
  private pendingDelete: string | null = null;
  private notice: string | null = null;
  private _focused = false;

  // The TUI focuses this component; the inner Input needs the state for its
  // cursor/placeholder and correct IME positioning.
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  constructor(host: TaskHost, tui: TUI, theme: Theme, done: () => void, showAll = false) {
    this.host = host;
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.showAll = showAll;
    this.input = new Input({
      prompt: "> ",
      placeholder: "filter tasks…",
      placeholderStyle: (s) => theme.fg("dim", s),
    });
    this.refresh();
    this.list = this.buildList();
  }

  invalidate(): void {
    this.input.invalidate();
    this.list.invalidate();
  }

  private refresh(): void {
    this.store = readStore();
    this.tasks = scopedTasks(this.showAll, this.host.cwd, this.store);
    if (this.pendingDelete && !this.tasks.some((t) => t.id === this.pendingDelete)) {
      this.pendingDelete = null;
    }
  }

  // SelectList items are fixed at construction; rebuild on store mutations,
  // preserving the filter text and selected task.
  private buildList(selectedId?: string): SelectList {
    const items = this.tasks.map((r) => taskSelectItem(r, this.host.sessionId, this.store));
    const list = new SelectList(items, Math.min(Math.max(items.length, 1), MAX_VISIBLE_TASKS), selectTheme(this.theme));
    list.setFilter(this.input.getValue());
    if (selectedId) {
      const idx = items.findIndex((i) => i.value === selectedId);
      if (idx >= 0) list.setSelectedIndex(idx);
    }
    list.onSelect = (item) => {
      const task = this.tasks.find((t) => t.id === item.value);
      // fireNow force-claims without an inScope check; the panel must uphold
      // the project-scoping invariant itself when showing all projects.
      if (task && !inScope(task, this.host.cwd)) {
        this.notice = `${task.id} belongs to ${task.project_root ?? "another project"} — fire it from there`;
      } else {
        this.host.fire(item.value);
        this.refresh();
        this.list = this.buildList();
      }
      this.tui.requestRender();
    };
    list.onCancel = () => this.done();
    return list;
  }

  private selectedTask(): ScheduledTask | undefined {
    const item = this.list.getSelectedItem();
    return this.tasks.find((t) => t.id === item?.value);
  }

  handleInput(data: string): void {
    this.notice = null;
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      if (this.pendingDelete) this.pendingDelete = null;
      else if (this.preview) this.preview = false;
      else {
        this.done();
        return;
      }
    } else if (matchesKey(data, "ctrl+d")) {
      const task = this.selectedTask();
      if (task) {
        if (this.pendingDelete === task.id) {
          this.host.remove(task.id);
          this.pendingDelete = null;
          this.refresh();
          this.list = this.buildList();
        } else {
          this.pendingDelete = task.id;
        }
      }
    } else if (matchesKey(data, "ctrl+a")) {
      this.showAll = !this.showAll;
      this.refresh();
      this.list = this.buildList();
    } else if (matchesKey(data, "ctrl+o")) {
      if (this.selectedTask()) this.preview = !this.preview;
    } else if (
      matchesKey(data, "up") ||
      matchesKey(data, "down") ||
      matchesKey(data, "pageUp") ||
      matchesKey(data, "pageDown") ||
      matchesKey(data, "enter") ||
      matchesKey(data, "tab")
    ) {
      this.pendingDelete = null;
      this.list.handleInput(data);
    } else {
      this.pendingDelete = null;
      this.input.handleInput(data);
      this.list.setFilter(this.input.getValue());
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const th = this.theme;
    const scope = this.showAll ? "all projects" : "this project";
    const lines: string[] = [""];
    lines.push(rule(width, th));
    lines.push("");
    lines.push(truncateToWidth(` ${th.fg("accent", th.bold("Scheduled Tasks"))} ${th.fg("muted", `— ${scope} · ${this.tasks.length}`)}`, width));
    lines.push("");
    lines.push(...this.input.render(width));
    lines.push("");
    if (this.tasks.length === 0) {
      const hint = this.showAll ? "No scheduled tasks at all." : "No tasks in this project — ctrl+a to show all.";
      lines.push(truncateToWidth(`   ${th.fg("dim", hint)}`, width));
    } else {
      lines.push(...this.list.render(width));
      const task = this.selectedTask();
      if (task && this.preview) {
        lines.push("");
        for (const w of wrapTextWithAnsi(task.prompt, Math.max(10, width - 6))) {
          lines.push(truncateToWidth(`   ${th.fg("dim", "│")} ${w}`, width));
        }
      }
    }
    lines.push("");
    if (this.notice) {
      lines.push(truncateToWidth(` ${th.fg("error", this.notice)}`, width));
    } else if (this.pendingDelete) {
      lines.push(truncateToWidth(` ${th.fg("error", `ctrl+d again to delete ${this.pendingDelete} · esc to cancel`)}`, width));
    } else {
      lines.push(
        truncateToWidth(
          ` ${th.fg("dim", "↑↓ navigate · enter fire · ctrl+d delete · ctrl+o preview · ctrl+a all projects · esc close")}`,
          width,
        ),
      );
    }
    lines.push("");
    lines.push(rule(width, th));
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
      this.selected = Math.min(Math.max(0, this.tasks.length - 1), this.selected + 1);
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
