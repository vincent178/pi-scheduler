import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Engine } from "./engine.ts";
import { parseSchedule, initialNextFire, resolveTaskSchedule } from "./schedule.ts";
import {
  updateStore,
  readStore,
  readLog,
  logEvent,
  newTaskId,
  type ScheduledTask,
  type Schedule,
} from "./store.ts";
import { resolveProjectRoot, inScope } from "./project.ts";
import { formatScheduledTask, relTime, scheduleDesc } from "./format.ts";
import {
  OverduePickComponent,
  TaskListComponent,
  nextFireAt,
  oneLine,
  scopedTasks,
  taskRowLines,
  widgetLines,
  widgetTickMs,
  type TaskHost,
} from "./ui.ts";

interface AddArgs {
  when: string;
  prompt: string;
  global: boolean;
  notify: boolean;
}

export function parseAddArgs(raw: string): AddArgs {
  const global = /(^|\s)--global(\s|$)/.test(raw);
  const notify = /(^|\s)--notify(\s|$)/.test(raw);
  let rest = raw.replace(/(^|\s)--global(?=\s|$)/g, "$1").replace(/(^|\s)--notify(?=\s|$)/g, "$1").trim();

  if (!rest) throw new Error("usage: /schedule add <when> <prompt> [--global] [--notify]");

  // " -- " separates schedule from prompt explicitly; otherwise the longest
  // leading prefix that parses as a schedule wins.
  const sep = rest.indexOf(" -- ");
  if (sep >= 0) {
    return { when: rest.slice(0, sep).trim(), prompt: rest.slice(sep + 4).trim(), global, notify };
  }

  const words = rest.split(/\s+/);
  for (let i = words.length - 1; i >= 1; i--) {
    const when = words.slice(0, i).join(" ");
    try {
      parseSchedule(when);
      return { when, prompt: words.slice(i).join(" "), global, notify };
    } catch {
      // keep extending the prefix
    }
  }
  throw new Error(
    `could not find a schedule in "${rest}". Use "/schedule add <when> -- <prompt>" to separate explicitly.`,
  );
}

const SUBCOMMANDS = ["add", "list", "remove", "fire", "log"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

/** Exact name, alias, or unique prefix; "ambiguous" when a prefix matches several. */
export function resolveSubcommand(token: string | undefined): Subcommand | "ambiguous" | null {
  if (!token) return null;
  const alias: Record<string, Subcommand> = { ls: "list", rm: "remove" };
  if (alias[token]) return alias[token];
  if ((SUBCOMMANDS as readonly string[]).includes(token)) return token as Subcommand;
  const matches = SUBCOMMANDS.filter((s) => s.startsWith(token));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return "ambiguous";
  return null;
}

const USAGE =
  "usage: /schedule add <when> <prompt> [--global] [--notify] | list [--all] | remove <id> | fire <id> | log [n]";

export default function (pi: ExtensionAPI) {
  let engine: Engine | null = null;
  let sessionId = "";
  let sessionCwd = "";
  let widgetCtx: ExtensionContext | null = null;
  let widgetTimer: NodeJS.Timeout | null = null;

  function refreshWidget(): void {
    if (!widgetCtx || widgetCtx.mode !== "tui") return;
    widgetCtx.ui.setWidget("scheduler", widgetLines(widgetCtx.ui.theme, widgetCtx.cwd));
  }

  // Mutations must poke, or a freshly created short-fuse task waits out the
  // current 30s tick before the countdown switches to 1s.
  function scheduleWidgetTick(): void {
    if (!widgetCtx || widgetCtx.mode !== "tui") return;
    if (widgetTimer) clearTimeout(widgetTimer);
    widgetTimer = setTimeout(() => {
      refreshWidget();
      scheduleWidgetTick();
    }, widgetTickMs(nextFireAt(widgetCtx.cwd)));
    widgetTimer.unref();
  }

  function pokeWidget(): void {
    refreshWidget();
    scheduleWidgetTick();
  }

  function removeTask(id: string, via: "command" | "tool" | "overlay" = "command"): ScheduledTask | null {
    const removed = updateStore((data) => {
      const r = data.tasks.find((x) => x.id === id);
      if (!r) return { result: null as ScheduledTask | null };
      data.tasks = data.tasks.filter((x) => x.id !== id);
      return { result: r };
    });
    if (removed) {
      logEvent("cancelled", { id, session: sessionId, via });
      engine?.sweep();
      pokeWidget();
    }
    return removed;
  }

  function taskHost(ctx: ExtensionContext): TaskHost {
    return {
      sessionId,
      cwd: ctx.cwd,
      fire: (id) => {
        const ok = engine?.fireNow(id) ?? false;
        if (ok) pokeWidget();
        return ok;
      },
      remove: (id) => removeTask(id, "overlay"),
    };
  }

  /** Select-from-list fallback for /schedule remove|fire without an id. */
  async function pickTaskId(ctx: ExtensionContext, title: string): Promise<string | null> {
    const store = readStore();
    const tasks = scopedTasks(false, ctx.cwd, store);
    if (tasks.length === 0) {
      ctx.ui.notify("no tasks in scope — /schedule list --all for everything", "info");
      return null;
    }
    const options = tasks.map((r) => `${relTime(r.next_fire_at)}  ${r.id}  ${oneLine(r.prompt).slice(0, 60)}`);
    const picked = await ctx.ui.select(title, options);
    return picked === undefined ? null : tasks[options.indexOf(picked)].id;
  }

  function createTask(
    prompt: string,
    schedule: Schedule,
    opts: { notify: boolean; global: boolean; via: "command" | "tool" },
  ): ScheduledTask {
    const task: ScheduledTask = {
      id: newTaskId(),
      prompt,
      schedule,
      delivery: opts.notify ? "notify" : "prompt",
      scope: opts.global ? "global" : "project",
      project_root: opts.global ? null : resolveProjectRoot(sessionCwd),
      sticky_session_id: sessionId,
      next_fire_at: initialNextFire(schedule),
    };
    updateStore((data) => {
      data.tasks.push(task);
      return { result: null };
    });
    logEvent("created", {
      id: task.id,
      session: sessionId,
      schedule: scheduleDesc(schedule),
      delivery: task.delivery,
      scope: task.scope,
      via: opts.via,
    });
    engine?.sweep();
    pokeWidget();
    return task;
  }

  async function addWizard(ctx: ExtensionContext): Promise<void> {
    if (!engine) {
      ctx.ui.notify("task engine not running (no active session)", "error");
      return;
    }
    const when = await ctx.ui.input(
      "When should it fire?",
      '"in 30m", "at 15:00", "tomorrow at 9am", "every 45 minutes"',
    );
    if (!when?.trim()) return;
    let schedule: Schedule;
    try {
      schedule = parseSchedule(when);
    } catch (err) {
      ctx.ui.notify((err as Error).message, "error");
      return;
    }
    const prompt = await ctx.ui.editor("Task prompt — self-contained instruction for the agent");
    if (!prompt?.trim()) return;
    const delivery = await ctx.ui.select("Delivery", [
      "prompt — the agent executes it",
      "notify — passive reminder",
    ]);
    if (delivery === undefined) return;
    const scope = await ctx.ui.select("Scope", ["project — this project only", "global — any project"]);
    if (scope === undefined) return;
    const task = createTask(prompt.trim(), schedule, {
      notify: delivery.startsWith("notify"),
      global: scope.startsWith("global"),
      via: "command",
    });
    ctx.ui.notify(
      `⏰ ${task.id} fires ${relTime(task.next_fire_at)} — "${task.prompt}" (${task.delivery}, ${task.scope})`,
      "info",
    );
  }

  async function pickOverdue(overdue: ScheduledTask[], ctx: ExtensionContext): Promise<void> {
    if (ctx.mode === "tui") {
      const fireIds = await ctx.ui.custom<string[]>(
        (_tui, theme, _kb, done) => new OverduePickComponent(overdue, theme, (ids) => done(ids)),
      );
      for (const r of overdue) {
        if (fireIds.includes(r.id) && engine) engine.fireNow(r.id);
        else engine?.snoozeOverdue(r.id);
      }
      return;
    }
    if (!ctx.hasUI) {
      const list = overdue.map((r) => `${r.id}: ${r.prompt}`).join("; ");
      ctx.ui.notify(`⏰ ${overdue.length} overdue task(s) — ${list} — use /schedule fire <id>`, "warning");
      return;
    }
    for (const r of overdue) {
      const due = new Date(r.next_fire_at).toLocaleString();
      const fire = await ctx.ui.confirm(
        "Overdue task",
        `⏰ ${r.prompt}\n\nwas due ${due} (${relTime(r.next_fire_at)})\n\nFire it now in this session?`,
      );
      if (fire && engine) {
        engine.fireNow(r.id);
      } else {
        engine?.snoozeOverdue(r.id);
      }
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    sessionCwd = ctx.cwd;
    widgetCtx = ctx;
    refreshWidget();
    scheduleWidgetTick();
    engine = new Engine({
      sessionId,
      cwd: ctx.cwd,
      projectRoot: resolveProjectRoot(ctx.cwd),
      deliverPrompt: (text) => pi.sendUserMessage(text),
      notify: (text) => ctx.ui.notify(text, "info"),
      isBusy: () => !ctx.isIdle(),
      onIdle: (cb) => pi.on("agent_settled", () => cb()),
    });
    const overdue = engine.start();
    if (overdue.length > 0) await pickOverdue(overdue, ctx);
  });

  pi.on("session_shutdown", () => {
    if (widgetTimer) clearTimeout(widgetTimer);
    widgetTimer = null;
    widgetCtx = null;
    engine?.shutdown();
    engine = null;
  });

  type ToolDetails = { task?: ScheduledTask; tasks?: ScheduledTask[]; error?: string };
  const toolFail = (message: string) => ({
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    details: { error: message } as ToolDetails,
  });
  const toolOk = (text: string, details: ToolDetails) => ({
    content: [{ type: "text" as const, text }],
    details,
  });

  pi.registerTool({
    name: "create_schedule_task",
    label: "Create Scheduled Task",
    description: [
      "Schedule a task for later: at fire time the prompt is injected as a user message for the agent to execute (with notify=true it is only a passive reminder).",
      "Use this whenever the user asks to do, check, or be reminded of something at a future time, after a delay, or repeatedly — in any language.",
      "Provide exactly one of at/delay/every: delay = relative offset like \"24h\", \"30m\", \"2 days\" — prefer it for relative times, it needs no clock; every = recurring interval like \"45m\", \"1h\"; at = absolute ISO 8601 datetime in local time — only for explicit wall-clock times, and run `date` first if you don't know the current local time.",
      "Tasks fire only while a pi session is running, and only in the project where they were scheduled unless global=true.",
    ].join(" "),
    parameters: Type.Object({
      prompt: Type.String({
        description: "Self-contained instruction for the agent to execute when the task fires",
      }),
      at: Type.Optional(Type.String({ description: "Absolute fire time, ISO 8601 (one-shot)" })),
      delay: Type.Optional(Type.String({ description: 'Fire after this delay, e.g. "24h", "30m" (one-shot)' })),
      every: Type.Optional(Type.String({ description: 'Recurring interval, e.g. "45m", "1h"' })),
      notify: Type.Optional(
        Type.Boolean({ description: "Passive notification instead of an agent-executed prompt (default false)" }),
      ),
      global: Type.Optional(
        Type.Boolean({ description: "Fire in any project instead of only the current one (default false)" }),
      ),
    }),
    async execute(_toolCallId, params) {
      if (!engine) return toolFail("task engine not running (no active session)");
      if (!params.prompt.trim()) return toolFail("prompt must not be empty");
      let schedule: Schedule;
      try {
        schedule = resolveTaskSchedule(params);
      } catch (err) {
        return toolFail((err as Error).message);
      }
      const task = createTask(params.prompt, schedule, {
        notify: params.notify ?? false,
        global: params.global ?? false,
        via: "tool",
      });
      return toolOk(
        `Scheduled ${task.id}: fires ${relTime(task.next_fire_at)} (${scheduleDesc(schedule)}, ${task.delivery}, ${task.scope}) — "${task.prompt}"`,
        { task },
      );
    },
  });

  pi.registerTool({
    name: "list_schedule_tasks",
    label: "List Scheduled Tasks",
    description:
      "List scheduled tasks with their id, fire time, delivery, scope, and prompt. Defaults to tasks in the current project; set all=true to include every project.",
    parameters: Type.Object({
      all: Type.Optional(Type.Boolean({ description: "Include tasks from other projects (default false)" })),
    }),
    async execute(_toolCallId, params) {
      const store = readStore();
      const tasks = store.tasks
        .filter((r) => params.all || inScope(r, sessionCwd))
        .sort((a, b) => Date.parse(a.next_fire_at) - Date.parse(b.next_fire_at));
      if (tasks.length === 0) {
        return toolOk(params.all ? "No scheduled tasks." : "No scheduled tasks in this project.", { tasks: [] });
      }
      return toolOk(tasks.map((r) => formatScheduledTask(r, sessionId, store)).join("\n"), { tasks });
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("list_schedule_tasks")) + theme.fg("muted", args.all ? " (all projects)" : ""),
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as ToolDetails | undefined;
      if (details?.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
      const tasks = details?.tasks ?? [];
      if (tasks.length === 0) return new Text(theme.fg("dim", "No scheduled tasks"), 0, 0);
      const store = readStore();
      let text = theme.fg("muted", `${tasks.length} scheduled task(s):`);
      const display = expanded ? tasks : tasks.slice(0, 6);
      for (const r of display) {
        const [meta, prompt] = taskRowLines(r, theme, 100, sessionId, store);
        text += expanded ? `\n${meta}\n${prompt}` : `\n${meta}`;
      }
      if (!expanded && tasks.length > 6) {
        text += `\n${theme.fg("dim", `... ${tasks.length - 6} more (expand to see)`)}`;
      }
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool({
    name: "cancel_schedule_task",
    label: "Cancel Scheduled Task",
    description:
      "Cancel a scheduled task by id (get ids from list_schedule_tasks). Only tasks in the current project can be cancelled.",
    parameters: Type.Object({
      id: Type.String({ description: "Task id, e.g. t-abc123-def456" }),
    }),
    async execute(_toolCallId, params) {
      const task = readStore().tasks.find((x) => x.id === params.id);
      if (!task) return toolFail(`no task ${params.id}`);
      if (!inScope(task, sessionCwd)) {
        return toolFail(`task ${params.id} belongs to another project; cancel it from there or with /schedule remove`);
      }
      removeTask(params.id, "tool");
      return toolOk(`Cancelled ${params.id} — "${task.prompt}"`, { task });
    },
  });

  pi.registerCommand("schedule", {
    description: "Manage tasks: add <when> <prompt> | list [--all] | remove <id> | fire <id> | log [n]",
    handler: async (args, ctx) => {
      const [rawSub, ...restTokens] = args.trim().split(/\s+/).filter(Boolean);
      const rest = restTokens.join(" ");
      const sub = resolveSubcommand(rawSub);
      if (sub === "ambiguous") {
        ctx.ui.notify(`ambiguous subcommand "${rawSub}" — ${USAGE}`, "error");
        return;
      }

      switch (sub) {
        case "add": {
          if (!rest) {
            if (ctx.mode !== "tui") {
              ctx.ui.notify(USAGE, "error");
              return;
            }
            await addWizard(ctx);
            return;
          }
          if (!engine) {
            ctx.ui.notify("task engine not running (no active session)", "error");
            return;
          }
          let parsed: AddArgs;
          let schedule: Schedule;
          try {
            parsed = parseAddArgs(rest);
            schedule = parseSchedule(parsed.when);
          } catch (err) {
            ctx.ui.notify((err as Error).message, "error");
            return;
          }
          if (!parsed.prompt) {
            ctx.ui.notify("missing task text", "error");
            return;
          }
          const task = createTask(parsed.prompt, schedule, { ...parsed, via: "command" });
          ctx.ui.notify(
            `⏰ ${task.id} fires ${relTime(task.next_fire_at)} — "${task.prompt}" (${task.delivery}, ${task.scope})`,
            "info",
          );
          return;
        }

        case "list": {
          const all = restTokens.includes("--all");
          if (ctx.mode === "tui") {
            await ctx.ui.custom<void>(
              (tui, theme, _kb, done) => new TaskListComponent(taskHost(ctx), tui, theme, () => done(), all),
            );
            return;
          }
          const store = readStore();
          const tasks = store.tasks.filter((r) => all || inScope(r, ctx.cwd));
          if (tasks.length === 0) {
            ctx.ui.notify(all ? "no tasks at all" : "no tasks in scope — /schedule list --all for everything", "info");
            return;
          }
          const lines = tasks
            .sort((a, b) => Date.parse(a.next_fire_at) - Date.parse(b.next_fire_at))
            .map((r) => formatScheduledTask(r, sessionId, store));
          ctx.ui.notify(lines.join("\n"), "info");
          return;
        }

        case "remove": {
          let id = rest;
          if (!id) {
            if (ctx.mode !== "tui") {
              ctx.ui.notify("usage: /schedule remove <id>", "error");
              return;
            }
            id = (await pickTaskId(ctx, "Remove which task?")) ?? "";
            if (!id) return;
          }
          const removed = removeTask(id);
          if (!removed) {
            ctx.ui.notify(`no task ${id}`, "error");
            return;
          }
          ctx.ui.notify(`removed ${id} — "${removed.prompt}"`, "info");
          return;
        }

        case "fire": {
          let id = rest;
          if (!id) {
            if (ctx.mode !== "tui") {
              ctx.ui.notify("usage: /schedule fire <id>", "error");
              return;
            }
            id = (await pickTaskId(ctx, "Fire which task now?")) ?? "";
            if (!id) return;
          }
          const target = readStore().tasks.find((x) => x.id === id);
          if (!target) {
            ctx.ui.notify(`no task ${id}`, "error");
            return;
          }
          if (!inScope(target, ctx.cwd)) {
            ctx.ui.notify(`task ${id} belongs to another project; fire it from there`, "error");
            return;
          }
          if (!engine?.fireNow(id)) {
            ctx.ui.notify(`no task ${id}`, "error");
            return;
          }
          pokeWidget();
          ctx.ui.notify(`fired ${id} — this session now owns it`, "info");
          return;
        }

        case "log": {
          const n = Number(rest) || 20;
          const events = readLog(n);
          if (events.length === 0) {
            ctx.ui.notify("run log is empty", "info");
            return;
          }
          const lines = events.map((e) => {
            const { ts, event, ...fields } = e;
            const detail = Object.entries(fields)
              .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
              .join(" ");
            return `${new Date(ts).toLocaleTimeString()} ${event}${detail ? ` ${detail}` : ""}`;
          });
          ctx.ui.notify(lines.join("\n"), "info");
          return;
        }

        default:
          ctx.ui.notify(USAGE, "info");
      }
    },
  });
}
