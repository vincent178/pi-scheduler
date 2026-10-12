import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Engine } from "./engine.ts";
import { parseSchedule, initialNextFire, resolveTaskSchedule } from "./schedule.ts";
import {
  updateStore,
  readStore,
  readLog,
  logEvent,
  newTaskId,
  isSessionAlive,
  type ScheduledTask,
  type Schedule,
} from "./store.ts";
import { resolveProjectRoot, inScope } from "./project.ts";

function relTime(iso: string, now = Date.now()): string {
  const diff = Date.parse(iso) - now;
  const abs = Math.abs(diff);
  const unit =
    abs < 60_000 ? `${Math.round(abs / 1000)}s`
    : abs < 3_600_000 ? `${Math.round(abs / 60_000)}m`
    : abs < 86_400_000 ? `${Math.round(abs / 3_600_000)}h`
    : `${Math.round(abs / 86_400_000)}d`;
  return diff >= 0 ? `in ${unit}` : `${unit} ago`;
}

function scheduleDesc(s: Schedule): string {
  return s.type === "once" ? `once at ${new Date(s.at).toLocaleString()}` : `every ${s.every_minutes}m`;
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-6)}` : id;
}

function formatScheduledTask(r: ScheduledTask, mySession: string, store = readStore()): string {
  const owner = !r.sticky_session_id
    ? "unowned"
    : r.sticky_session_id === mySession
      ? "this session"
      : `${shortId(r.sticky_session_id)}${isSessionAlive(store, r.sticky_session_id) ? "" : " (stale)"}`;
  const scope = r.scope === "global" ? "global" : `project:${r.project_root ?? "?"}`;
  return `${r.id}  ${relTime(r.next_fire_at)}  [${scheduleDesc(r.schedule)}]  ${r.delivery}  ${scope}  owner:${owner}\n    ${r.prompt}`;
}

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

export default function (pi: ExtensionAPI) {
  let engine: Engine | null = null;
  let sessionId = "";
  let sessionCwd = "";

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
    return task;
  }

  async function pickOverdue(overdue: ScheduledTask[], ctx: ExtensionContext): Promise<void> {
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
    engine?.shutdown();
    engine = null;
  });

  pi.registerTool({
    name: "schedule",
    label: "Schedule Task",
    description: [
      "Schedule a task for later: at fire time the prompt is injected as a user message for the agent to execute (with notify=true it is only a passive reminder).",
      "Use this whenever the user asks to do, check, or be reminded of something at a future time, after a delay, or repeatedly — in any language.",
      "Provide exactly one of at/delay/every: at = absolute ISO 8601 datetime in local time (derive it from the current date/time in the system prompt); delay = relative offset like \"24h\", \"30m\", \"2 days\"; every = recurring interval like \"45m\", \"1h\".",
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
      type Details = { task?: ScheduledTask; error?: string };
      const fail = (message: string) => ({
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        details: { error: message } as Details,
      });
      if (!engine) return fail("task engine not running (no active session)");
      if (!params.prompt.trim()) return fail("prompt must not be empty");
      let schedule: Schedule;
      try {
        schedule = resolveTaskSchedule(params);
      } catch (err) {
        return fail((err as Error).message);
      }
      const task = createTask(params.prompt, schedule, {
        notify: params.notify ?? false,
        global: params.global ?? false,
        via: "tool",
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Scheduled ${task.id}: fires ${relTime(task.next_fire_at)} (${scheduleDesc(schedule)}, ${task.delivery}, ${task.scope}) — "${task.prompt}"`,
          },
        ],
        details: { task } as Details,
      };
    },
  });

  pi.registerCommand("schedule", {
    description: "Manage tasks: add <when> <prompt> | list [--all] | remove <id> | fire <id> | log [n]",
    handler: async (args, ctx) => {
      const [sub, ...restTokens] = args.trim().split(/\s+/).filter(Boolean);
      const rest = restTokens.join(" ");

      switch (sub) {
        case "add": {
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

        case "list":
        case "ls": {
          const all = restTokens.includes("--all");
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

        case "remove":
        case "rm": {
          if (!rest) {
            ctx.ui.notify("usage: /schedule remove <id>", "error");
            return;
          }
          const removed = updateStore((data) => {
            const r = data.tasks.find((x) => x.id === rest);
            if (!r) return { result: null as ScheduledTask | null };
            data.tasks = data.tasks.filter((x) => x.id !== rest);
            return { result: r };
          });
          if (!removed) {
            ctx.ui.notify(`no task ${rest}`, "error");
            return;
          }
          logEvent("cancelled", { id: rest, session: sessionId });
          engine?.sweep();
          ctx.ui.notify(`removed ${rest} — "${removed.prompt}"`, "info");
          return;
        }

        case "fire": {
          if (!rest) {
            ctx.ui.notify("usage: /schedule fire <id>", "error");
            return;
          }
          if (!engine?.fireNow(rest)) {
            ctx.ui.notify(`no task ${rest}`, "error");
            return;
          }
          ctx.ui.notify(`fired ${rest} — this session now owns it`, "info");
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
          ctx.ui.notify(
            "usage: /schedule add <when> <prompt> [--global] [--notify] | list [--all] | remove <id> | fire <id> | log [n]",
            "info",
          );
      }
    },
  });
}
