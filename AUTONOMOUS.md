# OpenUI — Autonomous Coding Mode (Phase 8)

This document is the full reference for OpenUI's background autonomous coding
feature. For the high-level architecture summary see
[`ARCHITECTURE.md` §12](./ARCHITECTURE.md).

## 1. What it does

When **Autonomous Coding Mode** is enabled and the user is *away* — either
inactive for a configurable idle threshold (default **5 minutes**) or having
flipped a manual **"I'm busy"** toggle — OpenUI:

1. Pulls the next **pending task** from a task source (local `todo.json` or
   read-only GitHub Issues).
2. Spins up a coding agent in a **sandboxed workspace**.
3. Has the agent **write code**, run **`npm test`**, read the failures, and
   **iterate** until the tests pass — with no user in the loop.
4. Records the outcome and moves to the next task.
5. **Pauses** the moment the user returns to the keyboard, leaving any
   in-flight task pending for the next idle window.

Throughout, progress is streamed to the **"Background Agent Working…"** banner
and the shared task list in `TaskListPopup.tsx`.

## 2. Components

| File | Responsibility |
|---|---|
| `src/main/scheduler.ts` | Activity monitor + all mode state + autonomous IPC |
| `src/main/autonomous.ts` | The per-task write→test→iterate loop |
| `src/main/codingTools.ts` | Sandbox-only tools: `write_file`, `read_file`, `list_files`, `run_tests` |
| `src/main/sandbox.ts` | Workspace creation, path confinement, `npm test` runner |
| `src/main/tasks.ts` | Task sources (`todo.json`, GitHub Issues), status persistence |
| `src/renderer/src/components/TaskListPopup.tsx` | Banner + Autonomous / I'm-busy toggles |

## 3. The scheduler (`scheduler.ts`)

- Polls `powerMonitor.getSystemIdleTime()` (Electron built-in, cross-platform,
  **zero extra dependencies**) every **15 s**.
- **Trigger:** `enabled && (manualBusy || idleSec >= threshold)` and the loop is
  not already running → `runAutonomousCoding(win, tier, source)`.
- **Yield:** while the loop runs, if `!manualBusy && idleSec <= 5` (user is back)
  → `requestAutonomousStop()` (cooperative — the loop checks the flag at each
  turn/task boundary).
- Holds the mode state: `enabled`, `manualBusy`, `tier`, `source`.
- Registers the Phase 8 IPC handlers and broadcasts `AutonomousStatus`.
- On `before-quit`, stops the timer and requests a stop so no test run is
  orphaned.

Idle poll timer is `unref()`-ed so it never keeps the process alive on its own
(the tray already does that).

## 4. The coding loop (`autonomous.ts`)

For each task, `workOnTask()` runs a bounded agentic loop (max **20 turns**):

```
user: TASK (source): <title>\nDetails: <body>\nComplete this task, then run the tests until they pass.
loop:
  assistant ← callModel(win, tier, messages, CODING_SYSTEM_PROMPT)
  parseToolCall(assistant)
    • tool call → executeCodingTool(tool, args)
                  emit openui:task:update (working → done/error)
                  push "TOOL RESULT [tool] …" back as a user message
                  (track whether the last run_tests said "TESTS PASSED")
    • plain text → done. success = lastTestsPassed && !/^GIVE UP:/
```

`runAutonomousCoding()` loops over tasks (max **5 per idle window**), calling
`recordTaskOutcome()` after each, and emits `AutonomousStatus` transitions.

The loop reuses `callModel`, `parseToolCall`, and `emit` from `agent.ts` (those
were exported in Phase 8; `callModel` now takes an explicit `systemPrompt` so the
interactive assistant and the coding agent can use different prompts and tool
sets through one router).

## 5. The sandbox (`sandbox.ts`)

- **Workspace:** `app.getPath('userData')/autonomous-workspace` (override with
  `OPENUI_WORKSPACE`).
- **Path confinement:** every model-supplied path is `resolve()`d against the
  workspace and rejected if `relative(workspace, abs)` is empty, starts with
  `..`, or is absolute — so no `../` traversal or absolute-path escape.
- **Write limit:** 512 KB per file.
- **`runTests()`:** requires a `package.json`, then runs the **static** command
  `npm test --silent` in the workspace with a **120 s timeout** and **256 KB**
  output cap. Non-zero exit (failing tests) is reported as `passed:false` with
  the captured log — it is *not* thrown. On Windows the `npm.cmd` shim is
  launched via `shell:true` (safe: the command contains no model data).

## 6. Task sources (`tasks.ts`)

### Local `todo.json`

Lives in the workspace root:

```json
{
  "tasks": [
    { "id": "1", "title": "Add a sum() util with tests", "description": "…", "status": "pending" }
  ]
}
```

`status` is one of `pending | done | failed`. The agent reads `pending` tasks and
writes back `done`/`failed` so progress survives restarts and is visible to the
user. The file is treated as untrusted input and normalised on load.

### GitHub Issues (read-only)

Set `GITHUB_REPO="owner/name"` and (recommended) `GITHUB_TOKEN`. Open issues are
fetched via the GitHub REST API (`fetch` is global in Electron's main process),
PRs are filtered out, and each becomes a task `gh-<number>`.

**The loop never writes to GitHub** — no closing, commenting, or labelling.
Outward-facing, hard-to-reverse actions stay under explicit user control.
Attempted issues are mirrored into the local `todo.json` (by id) so the same
issue isn't picked up again next idle cycle.

Select the source with `OPENUI_TASK_SOURCE=github` (default `todo`) or via the
`source` field of `setAutonomousEnabled`.

## 7. Renderer UI (`TaskListPopup.tsx`)

- On mount: `getAutonomousStatus()` hydrates state, then `onAutonomousStatus`
  subscribes to pushes.
- **Banner** (when `active`): a pulsing dot + **"Background Agent Working… —
  <task>"** while `working`; a steady dot + monitoring/paused text otherwise.
- **Toggles:** *Autonomous* (master switch → `setAutonomousEnabled`) and *I'm
  busy* (`setBusy`). Disabling autonomous also clears the busy flag locally.
- Per-tool rows reuse the existing task-list rendering, so a coding run looks
  just like an interactive run — but the rows say "Write …", "Run npm test", etc.

## 8. Configuration reference

| Env var | Default | Meaning |
|---|---|---|
| `OPENUI_IDLE_THRESHOLD` | `300` | Seconds of inactivity before "away" |
| `OPENUI_WORKSPACE` | `userData/autonomous-workspace` | Sandbox root |
| `OPENUI_TASK_SOURCE` | `todo` | `todo` or `github` |
| `GITHUB_REPO` | *(unset)* | `owner/name` for the GitHub source |
| `GITHUB_TOKEN` | *(unset)* | Token with repo read scope |

The chat tier (`free`/`pro`/`enterprise`) used for autonomous runs defaults to
`free` (local Ollama — no cloud calls) and can be overridden per the `tier`
argument of `setAutonomousEnabled`. The same model-router env vars from
`agent.ts` apply (`OLLAMA_*`, `ANTHROPIC_API_KEY`, `GLM_*`).

## 9. Security & trust model

- **Containment, not a hostile-code sandbox.** Running tests executes arbitrary
  workspace code on purpose. `sandbox.ts` bounds *file paths* and the test
  *command* (static, no injection surface), plus timeout/output caps — but it
  does not defend against deliberately malicious code in the workspace. **For
  untrusted task sources, run OpenUI inside a container or VM.** A first-class
  **Docker execution backend** is the planned hardening step (see §10).
- **No desktop control while unattended.** The autonomous agent is wired to the
  `codingTools` registry only; it cannot move the mouse, synthesise keystrokes
  into other apps, launch apps, or read the screen — eliminating the
  `open_app`+`type_text` code-execution chain for the background path entirely.
- **Read-only external state.** GitHub is never mutated from the loop.
- **Bounded resource use.** ≤ 5 tasks per idle window, ≤ 20 turns per task,
  120 s per test run, cooperative pause on user return.
- **Untrusted model output.** Tool args are validated the same way as the
  interactive path; coding tools reject bad shapes and never throw to the loop.

## 10. Future enhancements

- **Docker backend** for `runTests()` / file ops — strong isolation for
  untrusted tasks (mount the workspace into a throwaway container, run tests
  there). The current `sandbox.ts` API (`writeSandboxFile`/`runTests`/…) is the
  seam where a `DockerSandbox` implementation would slot in.
- **Per-task git commits** in the workspace so each autonomous change is
  reviewable/revertable.
- **PR drafting** (still user-gated) instead of read-only GitHub.
- **Notification** (tray balloon / system notification) summarising what the
  background agent did while the user was away.
