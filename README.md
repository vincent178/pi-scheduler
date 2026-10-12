# pi-reminder

Time-based reminders for [pi](https://github.com/earendil-works/pi). Schedule a reminder
with natural-language time, and pi fires it as a prompt (the agent acts on it) or a
notification — in the session and project where it belongs.

## Features

- **Natural-language schedules** — `in 30m`, `at 15:00`, `every 45 minutes`, ISO dates
- **Prompt or notify delivery** — prompts inject a user message the agent acts on (default); notifications are passive
- **Project scoping** — a reminder fires only in the project that created it (git repo root, or the creating directory for non-git projects); `global` reminders fire anywhere
- **Session stickiness** — the creating session owns the reminder while it's alive; whichever session fires a reminder owns its next firings; ownership transfers when the owner closes or goes stale
- **Missed-reminder catch-up** — on session start, overdue in-scope reminders are listed; you pick which to fire
- **Busy-queue** — reminders that fire mid-turn are queued and delivered when the agent settles
- **Run log** — append-only JSONL audit trail of every reminder event

## Install

```bash
pi install git:github.com/vincent178/pi-reminder
```

Or load once without installing:

```bash
pi -e ./pi-reminder
```

## Usage

```text
/remind add in 30m check the deploy status
/remind add at 15:00 stretch break --notify
/remind add every 45 minutes poll CI --global
/remind list            # reminders in scope for this session
/remind list --all      # everything, across projects
/remind remove <id>
/remind fire <id>       # fire now; this session becomes the owner
/remind log             # recent run-log events
```

## Storage

| File | Contents |
|---|---|
| `~/.pi/agent/reminders.json` | reminder store + session presence registry (lockfile-guarded) |
| `~/.pi/agent/reminders.log` | append-only JSONL run log, capped at ~1 MB |

## Development

```bash
npm install
pi -e ./pi-reminder
```
