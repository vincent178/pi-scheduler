# AGENTS.md — pi-scheduler

A pi package for scheduled tasks: schedule a prompt at time A, the agent executes it at
time B. A notify-only task is just a reminder. See README.md for the full design.

## Structure

- `extensions/scheduler/` — the extension (`index.ts` wiring + `/schedule` command,
  `engine.ts` timers/stickiness/delivery, `store.ts` persistence + run log,
  `schedule.ts` natural-language parsing, `project.ts` project scoping,
  `format.ts` pi-free text formatting, `ui.ts` TUI components: task-list overlay,
  overdue picker, editor widget)
- `scripts/` — verification scripts, not a test framework

## Code style

- **Occam's Razor**: never introduce a field, state, variant, or branch without a real consumer. Derive state from existing data instead of adding fields to carry it.
- **Comments**: only document non-obvious constraints, invariants, or external behavior
  (e.g. the no-lock tolerance contract, heartbeat/staleness relation, chrono parsing
  workarounds, pi lifecycle ordering). Do not narrate what the code already says.
  No section-banner comments.
- Erasable TypeScript only (no enums, no parameter properties): Node ≥ 22.6 runs the
  files directly via type stripping, and tests import the extension source with explicit
  `.ts` extensions.
- Keep the engine pi-free: `engine.ts`, `store.ts`, `schedule.ts`, `project.ts`,
  `format.ts` must not import pi packages; `index.ts` is the only file that touches
  `ExtensionAPI` (`ui.ts` may import `@earendil-works/pi-tui` components and types).
- TUI work: survey pi's built-in selector patterns first (`SelectList`, `SettingsList`,
  the preset/session selectors in pi's extension examples) and match that inline-panel
  style; don't hand-roll overlay components. PRs that change TUI rendering must include
  a screenshot or terminal capture of the rendered result.

## Verification

Every change runs:

```bash
npx tsc                          # strict type check
node scripts/test-schedule.ts
node scripts/test-add-args.ts
PI_SCHEDULER_DIR=$(mktemp -d) node scripts/test-store.ts
PI_SCHEDULER_DIR=$(mktemp -d) node scripts/test-engine.ts
PI_SCHEDULER_DIR=$(mktemp -d) node scripts/test-engine-timers.ts
PI_SCHEDULER_DIR=$(mktemp -d) node scripts/test-ui.ts
```

Store/engine tests must use a fresh `PI_SCHEDULER_DIR` scratch dir — never the real
`~/.pi/agent`. Interactive end-to-end checks load the package with `pi -e .`.

## Invariants

- Timers (firing, heartbeat, sweep) start from `session_start` only, never in the
  extension factory; `session_shutdown` cleanup is idempotent and releases sticky claims.
- One-shot tasks are deleted from the store after firing; the run log is their history.
- A project task never fires outside its project; stickiness never overrides scoping.
- Overdue tasks are never auto-fired: they wait for the session-start pick.

## Git

- Work on a feature branch; never push to `main` directly. Commit and push after every
  change, then open a PR automatically with `gh pr create`. Confirm before merging a PR.
