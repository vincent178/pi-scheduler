# pi-scheduler

[![CI](https://github.com/vincent178/pi-scheduler/actions/workflows/ci.yml/badge.svg)](https://github.com/vincent178/pi-scheduler/actions/workflows/ci.yml)

**Reminders and scheduled tasks for [pi](https://github.com/earendil-works/pi), in plain language.**

Tell pi *"the PR just went live — check bugsnag for this error in 24 hours"* — or
`/schedule add in 45m take the laundry out --notify` — and walk away. When the time
comes, the task fires as a prompt the agent executes, or as a passive notification, in
the session and project where it belongs.

```text
──────────────────────────────────────────────────────────────────────────────────

 Scheduled Tasks — this project · 2

> filter tasks…

→ ⏰ in 23m · t-mv60hrjm   check CI and review status of PR #32806 — prompt
  ⏰ in 7h · t-mv50ba9m    verify Bugsnag errors stopped after PR #32782 merged — prompt

 ↑↓ navigate · enter fire · ctrl+d delete · ctrl+o preview · ctrl+a all projects · esc close

──────────────────────────────────────────────────────────────────────────────────
```

## Install

```bash
pi install git:github.com/vincent178/pi-scheduler
```

That's it — no daemon, no config. Try it: tell pi *"in 5 minutes, remind me to stretch"*,
or run `/schedule add` for the interactive wizard.

## Why

- **The agent remembers for you** — describe the task in your own words, in any
  language; the model turns it into a scheduled task via tools (`create_schedule_task` /
  `list` / `cancel`). No flags to learn if you don't want them.
- **No daemon, no cloud** — tasks fire while a pi session is running, from a local JSON
  file. Missed while away? The next session start offers them in one batch picker.
- **Fires where it belongs** — tasks are scoped to their project (git root or scheduling
  directory) and sticky to their session. A task about repo A never lands in repo B.
- **A real TUI, not a wall of text** — `/schedule list` is a filterable inline panel:
  fire, delete, preview, jump between projects. A widget above the editor always shows
  what's next.

## Usage

```text
/schedule add in 30m check the deploy status
/schedule add at 15:00 stretch break --notify
/schedule add every 45 minutes poll CI --global
/schedule add             # interactive wizard: when → prompt → delivery → scope
/schedule list            # inline panel (text fallback outside the TUI)
/schedule list --all      # include every project
/schedule remove [id]     # pick from a list when id omitted
/schedule fire [id]       # fire now; this session becomes the owner
/schedule log             # recent run-log events
```

Subcommands accept unique prefixes (`/schedule li`, `/schedule f`) plus `ls`/`rm` aliases.
Natural-language schedules work everywhere: `in 30m`, `at 15:00`, `every 45 minutes`,
ISO dates.

## How it works

**Delivery.** `prompt` (default) injects the task as a user message the agent executes;
`--notify` is passive. Tasks that come due mid-turn are queued until the agent settles;
notifications show immediately.

**Scoping.** Project tasks (default) fire only when the session's working directory is at
or under the project root — the git repo root, or the scheduling directory for non-git
projects. `--global` tasks fire anywhere. Other projects' tasks surface only as a one-line
digest at session start.

**Stickiness.** The scheduling session owns a task; the firing session takes over, so
recurring tasks keep landing in the same session. Ownership releases on shutdown (or after
a ~90s stale heartbeat), and the next in-scope session claims the task. Stickiness never
overrides scoping.

**Missed tasks.** No daemon means tasks only fire while pi is running. Overdue in-scope
tasks are listed at session start — pick which to fire; the rest wait for next time.

**Audit trail.** Every task event (`created`, `fired`, `sticky_claimed`, `deferred`,
`cancelled`, …) is one JSON line in `~/.pi/agent/scheduler.log` (capped at ~1 MB);
`/schedule log` tails it. One-shot tasks leave the store after firing — the log is their
history.

| File | Contents |
|---|---|
| `~/.pi/agent/scheduler.json` | task store + session presence registry (atomic tmp-write + rename) |
| `~/.pi/agent/scheduler.log` | append-only JSONL run log |

One race is accepted by design: two sessions firing the same task simultaneously may both
deliver — the store favors simplicity over serialization.

## Development

```bash
npm install
pi -ne -e .     # -ne avoids conflicts with an installed copy
```

Type check plus seven plain-`node` test scripts, including a pty-driven e2e that renders
the panel in a real pi TUI — see [AGENTS.md](AGENTS.md) for the full verification loop.

## License

MIT
