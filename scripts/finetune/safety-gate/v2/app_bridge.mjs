/**
 * app_bridge.mjs — the chat loop's own decisions, for `run_gate_v2.py --loop app`.
 *
 * The gate has twice measured a request the app never makes (thinking on, a
 * fixed context window). Re-implementing the loop's recovery in Python would be
 * a third chance to drift, so the gate asks the app's TypeScript directly:
 * toolCallParser.ts (what counts as a call, and the unknown-tool error) and
 * replyRecovery.ts (when a stalled reply gets a retry).
 *
 * One JSON request per stdin line, one JSON answer per stdout line:
 *   in:  {reply, userText, conversationText, knownTools: [...], allowNudge}
 *   out: {action: "tool", call} | {action: "final"}
 *      | {action: "retry", reason, message}   (message is the next user-role turn)
 *
 *   node --experimental-transform-types --no-warnings app_bridge.mjs
 */
import { register } from 'node:module'
import { createInterface } from 'node:readline'

register('../../../acceptance/ts-resolve-hook.mjs', import.meta.url)
const root = new URL('../../../../', import.meta.url)
const { parseToolCall, suggestToolNames, unknownToolError } = await import(new URL('src/main/toolCallParser.ts', root).href)
const { recoveryNudge } = await import(new URL('src/main/replyRecovery.ts', root).href)

function step(req) {
  const known = new Set(req.knownTools)
  const call = parseToolCall(req.reply, known)
  if (call && known.has(call.tool)) return { action: 'tool', call }
  if (call) {
    // agent.ts: executeTool says "Unknown tool", no MCP server has it, and the
    // loop feeds this back through formatToolResult.
    return { action: 'retry', reason: 'unknown_tool', message: `TOOL RESULT [${call.tool}] error: ${unknownToolError(call.tool, known)}` }
  }
  if (!req.allowNudge) return { action: 'final' }
  const r = recoveryNudge({
    userText: req.userText,
    reply: req.reply,
    conversationText: req.conversationText,
    knownTools: known,
    suggest: (name) => suggestToolNames(name, known)
  })
  return r ? { action: 'retry', reason: r.reason, message: r.message } : { action: 'final' }
}

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue
  let out
  try {
    out = step(JSON.parse(line))
  } catch (err) {
    out = { action: 'error', error: String(err && err.stack ? err.stack : err) }
  }
  process.stdout.write(JSON.stringify(out) + '\n')
}
