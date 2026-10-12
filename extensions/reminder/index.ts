import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Engine } from "./engine.ts";
import { parseSchedule, initialNextFire } from "./schedule.ts";
import {
  updateStore,
  readStore,
  readLog,
  logEvent,
  newReminderId,
  isSessionAlive,
  type Reminder,
  type Schedule,
} from "./store.ts";
import { resolveProjectRoot, inScope } from "./project.ts";

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

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

function formatReminder(r: Reminder, mySession: string, store = readStore()): string {
  const owner = !r.sticky_session_id
    ? "unowned"
    : r.sticky_session_id === mySession
      ? "this session"
      : `${shortId(r.sticky_session_id)}${isSessionAlive(store, r.sticky_session_id) ? "" : " (stale)"}`;
  const scope = r.scope === "global" ? "global" : `project:${r.project_root ?? "?"}`;
  const state = r.enabled ? relTime(r.next_fire_at) : "disabled";
  return `${r.id}  ${state}  [${scheduleDesc(r.schedule)}]  ${r.delivery}  ${scope}  owner:${owner}\n    ${r.prompt}`;
}

// ---------------------------------------------------------------------------
// add-subcommand argument parsing
// ---------------------------------------------------------------------------

interface AddArgs {
  when: string;
  prompt: string;
  global: boolean;
  notify: boolean;
}

export function parseAddArgs(raw: string): AddArgs {
  const global = /(^|\s)--global(\s|$)/.test(raw);
  const notify = /(^|\s)--notify(\s|$)/.test(raw);
  let rest = raw.replace(/\s*--global\b/g, "").replace(/\s*--notify\b/g, "").trim();

  if (!rest) throw new Error("usage: /remind add <when> <prompt> [--global] [--notify]");

  // Explicit separator wins: "/remind add in 30m -- check the deploy"
  const sep = rest.indexOf(" -- ");
  if (sep >= 0) {
    return { when: rest.slice(0, sep).trim(), prompt: rest.slice(sep + 4).trim(), global, notify };
  }

  // Otherwise find the longest leading prefix that parses as a schedule.
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
    `could not find a schedule in "${rest}". Use "/remind add <when> -- <prompt>" to separate explicitly.`,
  );
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let engine: Engine | null = null;
  let sessionId = "";

  async function pickOverdue(overdue: Reminder[], ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) {
      const list = overdue.map((r) => `${r.id}: ${r.prompt}`).join("; ");
      ctx.ui.notify(`⏰ ${overdue.length} overdue reminder(s) — ${list} — use /remind fire <id>`, "warning");
      return;
    }
    for (const r of overdue) {
      const due = new Date(r.next_fire_at).toLocaleString();
      const fire = await ctx.ui.confirm(
        "Overdue reminder",
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

  pi.registerCommand("remind", {
    description: "Manage reminders: add <when> <prompt> | list [--all] | remove <id> | fire <id> | log [n]",
    handler: async (args, ctx) => {
      const [sub, ...restTokens] = args.trim().split(/\s+/).filter(Boolean);
      const rest = restTokens.join(" ");

      switch (sub) {
        case "add": {
          if (!engine) {
            ctx.ui.notify("reminder engine not running (no active session)", "error");
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
            ctx.ui.notify("missing reminder text", "error");
            return;
          }
          const reminder: Reminder = {
            id: newReminderId(),
            prompt: parsed.prompt,
            schedule,
            delivery: parsed.notify ? "notify" : "prompt",
            scope: parsed.global ? "global" : "project",
            project_root: parsed.global ? null : resolveProjectRoot(ctx.cwd),
            sticky_session_id: sessionId,
            created_at: new Date().toISOString(),
            next_fire_at: initialNextFire(schedule),
            last_fired_at: null,
            enabled: true,
          };
          updateStore((data) => {
            data.reminders.push(reminder);
            return { result: null };
          });
          logEvent("created", {
            id: reminder.id,
            session: sessionId,
            schedule: scheduleDesc(schedule),
            delivery: reminder.delivery,
            scope: reminder.scope,
          });
          engine.sweep();
          ctx.ui.notify(
            `⏰ ${reminder.id} fires ${relTime(reminder.next_fire_at)} — "${reminder.prompt}" (${reminder.delivery}, ${reminder.scope})`,
            "info",
          );
          return;
        }

        case "list":
        case "ls": {
          const all = restTokens.includes("--all");
          const store = readStore();
          const reminders = store.reminders.filter((r) => all || inScope(r, ctx.cwd));
          if (reminders.length === 0) {
            ctx.ui.notify(all ? "no reminders at all" : "no reminders in scope — /remind list --all for everything", "info");
            return;
          }
          const lines = reminders
            .sort((a, b) => Date.parse(a.next_fire_at) - Date.parse(b.next_fire_at))
            .map((r) => formatReminder(r, sessionId, store));
          ctx.ui.notify(lines.join("\n"), "info");
          return;
        }

        case "remove":
        case "rm": {
          if (!rest) {
            ctx.ui.notify("usage: /remind remove <id>", "error");
            return;
          }
          const removed = updateStore((data) => {
            const r = data.reminders.find((x) => x.id === rest);
            if (!r) return { result: null as Reminder | null };
            data.reminders = data.reminders.filter((x) => x.id !== rest);
            return { result: r };
          });
          if (!removed) {
            ctx.ui.notify(`no reminder ${rest}`, "error");
            return;
          }
          logEvent("cancelled", { id: rest, session: sessionId });
          engine?.sweep();
          ctx.ui.notify(`removed ${rest} — "${removed.prompt}"`, "info");
          return;
        }

        case "fire": {
          if (!rest) {
            ctx.ui.notify("usage: /remind fire <id>", "error");
            return;
          }
          if (!engine?.fireNow(rest)) {
            ctx.ui.notify(`no enabled reminder ${rest}`, "error");
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
            "usage: /remind add <when> <prompt> [--global] [--notify] | list [--all] | remove <id> | fire <id> | log [n]",
            "info",
          );
      }
    },
  });
}
