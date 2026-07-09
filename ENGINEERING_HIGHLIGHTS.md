# Engineering Highlights

A curated, skimmable tour of the most demonstrable architectural patterns in this codebase — written for an outside reviewer who wants a fast read on engineering judgment, not a full spec. This is **not** a replacement for [ARCHITECTURE.md](./ARCHITECTURE.md), which covers the system exhaustively (IPC surface, DB schema, auth, Stripe/Supabase edge functions, build/CI).

## 1. Three-process Electron architecture behind a single typed bridge

Electron's three-process model (main / preload / renderer) is easy to get wrong by leaking Node access into the renderer. Here the entire main↔renderer surface is funneled through one `contextBridge.exposeInMainWorld` call with a single typed `api` object — every channel name is a string literal that only exists in one place, and every subscription method (`onChunk`, `onToolCall`, `onSubagentGroup`, ...) returns its own unsubscribe closure instead of leaving `ipcRenderer` listeners to leak.

`src/preload/index.ts:104-129, 143-153, 547-551`

```ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wrap = <T>(cb: (data: T) => void): IpcListener => ((_: any, data: T) => cb(data)) as IpcListener

const api = {
  ...
  chat: (message: string, tier: Tier): Promise<void> =>
    ipcRenderer.invoke('openui:chat', { message, tier }),

  onChunk: (cb: (chunk: string) => void): (() => void) => {
    const fn = wrap<string>(cb)
    ipcRenderer.on('openui:chat:chunk', fn)
    return (): void => { ipcRenderer.removeListener('openui:chat:chunk', fn) }
  },
  ...
}

export type OpenUIApi = typeof api

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('openui', api)
} else {
  window.openui = api
}
```

The paired main-process side registers the matching `invoke` handler and streams tokens back over the channel the bridge subscribed to, rather than resolving the whole response at once.

`src/main/agent.ts:329-333, 911-923`

```ts
export function emit(win: BrowserWindow, channel: string, ...args: unknown[]): void {
  if (!win.isDestroyed()) {
    win.webContents.send(channel, ...args)
  }
}
...
  ipcMain.handle('openui:chat', async (_event, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) return
    const { message, tier } = payload as Record<string, unknown>
    if (typeof message !== 'string' || !message.trim()) {
      emit(win, 'openui:chat:error', 'Invalid chat request: "message" must be a non-empty string.')
      return
    }
    if (message.length > MAX_MESSAGE_LEN) {
      emit(win, 'openui:chat:error', 'Message is too long.')
      return
    }
    await handleChat(win, message, coerceTier(tier))
  })
```

## 2. Real parallel sub-agent orchestration

Instead of faking a "parallel" UI on top of sequential tool calls, `spawn_subagents` genuinely fans out with `Promise.all`, capped at `MAX_SUBAGENTS = 4`, and pushes a live lifecycle stream (`group` → per-sub `tool`/`status` → `done` → `group-done`) to the renderer so the "running N in parallel" timeline reflects actual concurrent execution. The module is deliberately one-way decoupled from `agent.ts` to avoid an import cycle, and hard-codes its own safety rules (no destructive tools, no recursive spawning, bounded turns) rather than trusting the model to self-limit.

`src/main/subagents.ts:32-38, 193-217`

```ts
/** The virtual tool name the main agent emits to fan out. Never hits executeTool. */
export const SPAWN_SUBAGENTS_TOOL = 'spawn_subagents'

/** Hard cap on concurrent subagents (keeps model/CPU load and UI sane). */
export const MAX_SUBAGENTS = 4
/** Per-subagent tool-call budget — subtasks are meant to be small and focused. */
const SUBAGENT_MAX_TURNS = 6
...
  // Announce the whole group up front so the UI can render every row at once.
  emit(win, 'openui:subagent:group', { groupId, count: subs.length, subs })

  try {
    const outcomes = await Promise.all(
      clamped.map((spec, i) => runOneSubagent(win, groupId, subs[i].subId, spec, tier))
    )
    const allOk = outcomes.every((o) => o.ok)
    emit(win, 'openui:subagent:group-done', { groupId, status: allOk ? 'done' : 'error' })

    const lines = outcomes.map((o) => `- ${o.title}: ${o.ok ? '' : '(incomplete) '}${o.summary}`)
    return `Ran ${outcomes.length} sub-agents in parallel. Results:\n${lines.join('\n')}`
  } finally {
    // Drop this run's model assignments.
    for (const s of subs) subModels.delete(`${groupId}:${s.subId}`)
  }
```

The safety rules are stated up front as module-level intent, not buried in logic:

`src/main/subagents.ts:11-17`

```ts
 * Safety rules for subagents (enforced here, not left to the model):
 *   - No destructive tools (concurrent HITL prompts would be chaos; a subagent
 *     that needs one is told to report back instead).
 *   - No recursion: a subagent cannot itself spawn more subagents.
 *   - Bounded turns per subagent.
 * The module is intentionally decoupled from agent.ts (one-way import) to avoid
 * an import cycle: it re-implements the few tiny helpers it needs locally.
```

## 3. Hand-rolled streaming tool-call gate

The hardest part of building a JSON-tool-calling agent on top of a raw token stream is deciding, *while tokens are still arriving*, whether the response is becoming a hidden tool call or a prose answer the user should see live. `StreamGate` does this with no parsing library: it classifies the response from its first non-whitespace character, withholds anything that looks JSON-shaped, and streams everything else immediately — including text that *later* turns out to have a trailing tool call appended after chatty prose. `finalize()` handles the false-positive case (looked like JSON, wasn't a real registered tool) by revealing the buffered text. The logic is isolated with zero Electron/Node imports specifically so it can be unit-tested in plain Node (`toolCallParser.test.ts`).

`src/main/toolCallParser.ts:148-213`

```ts
export class StreamGate {
  private buffer = ''
  private decided: 'tool' | 'text' | null = null
  /** Chars of `buffer` already forwarded to the UI (text mode only). */
  private forwardedLen = 0

  constructor(private readonly forward: (delta: string) => void) {}

  /** Feed one streamed delta. Forwards to the UI only once classified as text. */
  push = (delta: string): void => {
    if (!delta) return
    this.buffer += delta

    if (this.decided === 'tool') return // pure tool JSON — keep withholding entirely

    if (this.decided === null) {
      // Inspect the leading non-whitespace character(s) to classify the response.
      const lead = this.buffer.replace(/^\s+/, '')
      if (lead === '') return // only whitespace so far — wait for more
      if (lead[0] === '`') {
        // Possibly the start of a ``` code fence — wait until we can be sure.
        if (lead.length < 3) return
        this.decided = 'tool'
        return
      }
      if (lead[0] === '{') {
        this.decided = 'tool'
        return
      }
      this.decided = 'text' // natural language — fall through to incremental flush
    }

    this.flushTextUpToJson()
  }
```

`extractFirstJsonObject` is the companion primitive — a string-aware balanced-brace scanner (so quoted braces don't end the object early) that tolerates trailing prose after the closing `}`:

`src/main/toolCallParser.ts:22-44`

```ts
export function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null // unbalanced — likely a still-streaming fragment
}
```

## 4. Repository pattern over SQLite

Persistence is factored out of `agent.ts` entirely into per-domain repositories (`conversationRepo`, `feedbackRepo`, `messageRepo`, `settingsRepo`, `subscriptionRepo`, `trainingRepo`, `userRepo`) that each expose plain functions over prepared statements, plus a dedicated `migrations.ts` that tracks applied migrations in their own table rather than diffing schema at boot.

`src/main/database/repositories/conversationRepo.ts:1-26`

```ts
import { getDb } from '../init'
import { randomUUID } from 'crypto'

export interface ConversationRow {
  id: string
  user_id: string | null
  title: string
  model_used: string | null
  tier_at_time: string | null
  created_at: number
  updated_at: number
}

export function createConversation(userId: string | null, title = 'New Chat'): string {
  const id = randomUUID()
  getDb()
    .prepare('INSERT INTO conversations (id, user_id, title) VALUES (?, ?, ?)')
    .run(id, userId, title)
  return id
}

export function getConversationsByUser(userId: string): ConversationRow[] {
  return getDb()
    .prepare('SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC')
    .all(userId) as ConversationRow[]
}
```

`src/main/database/migrations.ts:1-35`

```ts
const migrations: Migration[] = []

export function runMigrations(): void {
  const db = getDb()

  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      applied_at INTEGER DEFAULT (strftime('%s','now'))
    )
  `)

  const applied = new Set(
    (db.prepare('SELECT name FROM _migrations').all() as Array<{ name: string }>).map((r) => r.name)
  )

  for (const migration of migrations) {
    if (!applied.has(migration.name)) {
      db.transaction(() => {
        migration.up()
        db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(migration.name)
      })()
      console.log('[db] applied migration:', migration.name)
    }
  }
}
```

## 5. Human-in-the-loop approval as a blocking IPC promise

Rather than modeling approval as a callback or a re-entrant IPC round trip, the agent loop literally `await`s a `Promise<boolean>` that only resolves when the renderer's `HitlModal` responds. The resolver is parked in a `Map` keyed by request id; the `ipcMain.on('openui:hitl:response', ...)` handler is the only thing that can settle it. This keeps the agentic loop's control flow linear and readable — no state machine needed to represent "paused waiting for a human."

`src/main/agent.ts:59-77`

```ts
/** Resolvers keyed by request id, awaited while the renderer shows HitlModal. */
const pendingHitlRequests = new Map<string, (approved: boolean) => void>()
let hitlSeq = 0

/**
 * Emit a HITL request to the renderer and return a Promise that resolves once
 * the user clicks Allow (true) or Deny (false) in the HitlModal.
 */
function waitForHitlApproval(
  win: BrowserWindow,
  tool: string,
  args: Record<string, unknown>
): Promise<boolean> {
  const id = `hitl${++hitlSeq}`
  return new Promise<boolean>((resolve) => {
    pendingHitlRequests.set(id, resolve)
    emit(win, 'openui:hitl:request', { id, tool, args, label: describeToolCall(tool, args) })
  })
}
```

The resolving side, wired in `registerAgentIPC`:

`src/main/agent.ts:887-897`

```ts
  // Resolve the waiting agent loop turn when the user responds to a HITL prompt.
  ipcMain.on('openui:hitl:response', (_event, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) return
    const { id, approved } = payload as Record<string, unknown>
    if (typeof id !== 'string') return
    const resolve = pendingHitlRequests.get(id)
    if (resolve) {
      pendingHitlRequests.delete(id)
      resolve(approved === true)
    }
  })
```

## 6. Sandboxed autonomous execution

The autonomous coding agent runs unattended, so `sandbox.ts` bounds its blast radius with three independent controls: every path is resolved and verified to stay inside a single workspace directory (rejecting `..` traversal and absolute-path escapes), the only shell command it can ever run is the static, non-injectable `npm test` (the model never supplies the command string), and execution is wall-clock bounded with an output-size cap. The module's own doc comment is explicit about what this is and isn't: containment against a buggy/steered model, not a security boundary against deliberately hostile code.

`src/main/sandbox.ts:68-82`

```ts
function resolveInSandbox(workspace: string, relPath: string): string {
  if (typeof relPath !== 'string' || !relPath.trim()) {
    throw new Error('path must be a non-empty string')
  }
  if (isAbsolute(relPath)) {
    throw new Error('path must be relative to the workspace, not absolute')
  }
  const abs = resolve(workspace, relPath)
  const rel = relative(workspace, abs)
  // rel starting with ".." (or being absolute) means abs is outside workspace.
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('path escapes the workspace sandbox')
  }
  return abs
}
```

`src/main/sandbox.ts:150-176`

```ts
export async function runTests(): Promise<TestRunResult> {
  const cwd = await ensureWorkspace()
  ...
  const npmCmd = IS_WIN ? 'npm.cmd' : 'npm'
  try {
    const { stdout, stderr } = await execFileAsync(npmCmd, ['test', '--silent'], {
      cwd,
      timeout: TEST_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT,
      windowsHide: true,
      // npm.cmd on Windows is a batch shim and must be launched through the shell.
      shell: IS_WIN
    })
    const output = `${stdout}\n${stderr}`.trim().slice(0, MAX_OUTPUT)
    return { passed: true, output: output || 'Tests passed (no output).' }
  } catch (err) {
```

## 7. Plugin-style tool registry with destructive-action gating

Every tool the agent can call — OS automation, GitHub, Figma, MCP, RAG — is registered once as a `{ name, description, parameters }` schema plus an executor function, dispatched uniformly through one `executeTool`. State-changing tools are named explicitly in `STATE_CHANGING_TOOLS` and always come back as a `pending_approval` result unless the caller already has sign-off; a stricter `DESTRUCTIVE_TOOLS` subset (e.g. `delete_file`) always confirms even under "approve whole plan" or full-auto autonomy. OS automation itself never shells out — AppleScript and PowerShell are invoked via `execFile` with an argv array, and the Windows PowerShell binary is resolved to its absolute path under `%SystemRoot%` specifically to avoid a CWD-based binary-planting attack.

`src/main/tools.ts:2065-2077`

```ts
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: ExecutorContext = { tier: 'free' }
): Promise<ToolResult | PendingApprovalResult> {
  // Gate: require explicit user approval for any state-changing tool.
  if (STATE_CHANGING_TOOLS.has(name) && !context.bypassHitl) {
    return { status: 'pending_approval', tool: name, args }
  }

  const schema = toolSchemas.find((s) => s.name === name)
  const fn = registry[name]
  if (!schema || !fn) return { ok: false, error: `Unknown tool "${name}".` }
```

`src/main/tools.ts:1997-2024`

```ts
const registry: Record<string, Executor> = {
  open_app,
  open_whatsapp_chat,
  list_apps,
  search_files,
  control_calendar,
  move_mouse,
  left_click,
  type_text,
  read_screen,
  browser_navigate,
  browser_click,
  browser_extract_text,
  browser_fill_input,
  search_local_files,
  run_workflow,
  list_directory,
  read_file,
  write_file,
  create_folder,
  move_file,
  copy_file,
  delete_file,
  read_clipboard,
  write_clipboard,
  ...githubRegistry,
  ...figmaRegistry
}
```

`src/main/tools.ts:210-224`

```ts
function powerShellPath(): string {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}
```

## 8. State management via React Context + GSAP timelines instead of Redux

App-level state is two nested Context providers, not a Redux/Zustand store — `AuthProvider` wraps `TaskActivityProvider` wraps the `AppShell`, keeping auth identity and live task/activity state as two small, independently testable contexts instead of one global store. UI choreography (popup entrances, mic pulse rings, sound-bar animation) is driven by GSAP `gsap.context`/`gsap.timeline` calls scoped to a ref, rather than CSS transitions or a state-driven animation library — giving imperative, sequenced control (staggers, easing curves, cleanup via context revert) that plain CSS can't express as cleanly.

`src/renderer/src/App.tsx:273-281`

```tsx
export default function App(): JSX.Element {
  return (
    <AuthProvider>
      <TaskActivityProvider>
        <AppShell />
      </TaskActivityProvider>
    </AuthProvider>
  )
}
```

`src/renderer/src/hooks/useAssistantAnimations.ts:105-106`

```ts
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ defaults: { ease: 'expo.out' } })
```

---

For full technical depth (DB schema, auth flow, Stripe/Supabase edge functions, build/CI), see [ARCHITECTURE.md](./ARCHITECTURE.md).
