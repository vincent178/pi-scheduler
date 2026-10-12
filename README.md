# pi-scheduler

Scheduled tasks for [pi](https://github.com/earendil-works/pi). At time A you schedule a
task with natural-language time; at time B pi fires it as a prompt (the agent executes it)
or a notification — in the session and project where it belongs. A task with `notify`
delivery is just a reminder.

## Features

- **Natural-language schedules** — `in 30m`, `at 15:00`, `every 45 minutes`, ISO dates
- **Prompt or notify delivery** — prompts inject a user message the agent executes (default); notifications are passive
- **Project scoping** — a task fires only in the project that scheduled it (git repo root, or the creating directory for non-git projects); `global` tasks fire anywhere
- **Session stickiness** — the scheduling session owns the task while it's alive; whichever session fires a task owns its next firings; ownership transfers when the owner closes or goes stale
- **Missed-task catch-up** — on session start, overdue in-scope tasks are listed; you pick which to fire
- **Busy-queue** — tasks that come due mid-turn are queued and delivered when the agent settles
- **Run log** — append-only JSONL audit trail of every task event

## Install

```bash
pi install git:github.com/vincent178/pi-scheduler
```

Or load once without installing:

```bash
pi -e ./pi-scheduler
```

## Usage

```text
/schedule add in 30m check the deploy status
/schedule add at 15:00 stretch break --notify
/schedule add every 45 minutes poll CI --global
/schedule list            # tasks in scope for this session
/schedule list --all      # everything, across projects
/schedule remove <id>
/schedule fire <id>       # fire now; this session becomes the owner
/schedule log             # recent run-log events
```

## Scopes

- **project** (default) — fires only when the session's working directory is at or under the
  project root. The project root is the git repo root when inside a repo, otherwise the
  directory the task was scheduled in (non-git directories are first-class projects).
- **global** (`--global`) — fires in any session.

Project tasks are invisible elsewhere except as a one-line digest at session start:
`⏰ N pending tasks in other projects: …`.

## Delivery

- **prompt** (default) — injects the task as a user message; the agent executes it.
- **notify** (`--notify`) — passive notification only.

Tasks that come due while the agent is mid-turn are queued and delivered when the agent
settles. Notifications are shown immediately.

## Session stickiness

The session that schedules a task owns it while it is alive. When a task fires, the firing
session becomes its owner, so recurring tasks keep landing in the same session. Ownership
is released when the owning session shuts down (or its heartbeat goes stale after ~90s);
the next in-scope session to reach fire time claims it. Stickiness never overrides project
scoping. A lockfile-guarded claim in the store makes double-firing impossible even if two
sessions race.

## Missed tasks

Tasks only fire while a pi session is running — there is no daemon. When a session starts,
overdue in-scope tasks are listed one by one and you pick which to fire (picking also makes
your session the owner). Unpicked tasks stay overdue and are listed again at the next
session start.

## Run log

Every task event (`created`, `fired`, `deleted_after_fire`, `sticky_claimed`,
`sticky_transferred`, `sticky_released`, `sticky_held_skip`, `deferred`, `overdue_listed`,
`digest`, `cancelled`, `error`, …) is appended as one JSON line to the run log, capped at
~1 MB (truncation keeps the newest entries). `/schedule log [n]` shows the last n events.
One-shot tasks are deleted from the store after firing — the run log is their history.

## Storage

| File | Contents |
|---|---|
| `~/.pi/agent/scheduler.json` | task store + session presence registry (lockfile-guarded) |
| `~/.pi/agent/scheduler.log` | append-only JSONL run log, capped at ~1 MB |

## Development

```bash
npm install
pi -e ./pi-scheduler
```

Tests (plain `node`, no build step — Node ≥ 22.6 strips types natively):

```bash
npx tsc                                        # type check
node scripts/test-schedule.ts                  # schedule parsing
node scripts/test-add-args.ts                  # /schedule add arg splitting
PI_SCHEDULER_DIR=$(mktemp -d) node scripts/test-store.ts          # store concurrency
PI_SCHEDULER_DIR=$(mktemp -d) node scripts/test-engine.ts         # engine, two sessions
PI_SCHEDULER_DIR=$(mktemp -d) node scripts/test-engine-timers.ts  # real-timer firing
```
