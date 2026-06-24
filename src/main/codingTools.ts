/**
 * codingTools.ts — the tool surface for the autonomous coding agent (Phase 8).
 *
 * These are deliberately SEPARATE from the OS-automation tools in tools.ts. The
 * interactive desktop assistant can move the mouse, launch apps and read the
 * screen; the unattended coding agent must not. It only ever touches files
 * inside the sandbox workspace and runs the workspace test suite. Keeping the
 * two registries apart means a task/issue that tries to steer the coding agent
 * into clicking around the desktop simply has no such tool to call.
 *
 * Schemas reuse the ToolSchema/ToolResult shapes from tools.ts so they render
 * into the system prompt with the same renderer the interactive agent uses.
 */
import { writeSandboxFile, readSandboxFile, listSandboxFiles, runTests } from './sandbox'
import type { ToolSchema, ToolResult } from './tools'

type CodingExecutor = (args: Record<string, unknown>) => Promise<ToolResult>

async function write_file(args: Record<string, unknown>): Promise<ToolResult> {
  const path = typeof args.path === 'string' ? args.path : ''
  const content = typeof args.content === 'string' ? args.content : ''
  if (!path) return { ok: false, error: 'write_file requires a string "path".' }
  try {
    const written = await writeSandboxFile(path, content)
    return { ok: true, output: `Wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${written}.` }
  } catch (err) {
    return { ok: false, error: `write_file failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function read_file(args: Record<string, unknown>): Promise<ToolResult> {
  const path = typeof args.path === 'string' ? args.path : ''
  if (!path) return { ok: false, error: 'read_file requires a string "path".' }
  try {
    const content = await readSandboxFile(path)
    // Cap what we feed back so a large file cannot blow the context window.
    const capped = content.length > 16_000 ? content.slice(0, 16_000) + '\n…(truncated)' : content
    return { ok: true, output: capped }
  } catch (err) {
    return { ok: false, error: `read_file failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function list_files(): Promise<ToolResult> {
  try {
    const files = await listSandboxFiles()
    return {
      ok: true,
      output: files.length ? `Workspace files:\n${files.join('\n')}` : 'Workspace is empty.'
    }
  } catch (err) {
    return { ok: false, error: `list_files failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function run_tests(): Promise<ToolResult> {
  try {
    const result = await runTests()
    // Report PASS/FAIL in the output text (always ok:true) so the model reads
    // the test log and decides the next step rather than treating a normal
    // test failure as a tool error it should retry blindly.
    return {
      ok: true,
      output: `${result.passed ? 'TESTS PASSED' : 'TESTS FAILED'}\n${result.output}`
    }
  } catch (err) {
    return { ok: false, error: `run_tests failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export const codingToolSchemas: ToolSchema[] = [
  {
    name: 'write_file',
    description:
      'Create or overwrite a text file in the workspace. Paths are relative to the workspace root; parent directories are created automatically.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path, e.g. "src/index.js".' },
        content: { type: 'string', description: 'Full UTF-8 contents to write.' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'read_file',
    description: 'Read a text file from the workspace and return its contents.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' }
      },
      required: ['path']
    }
  },
  {
    name: 'list_files',
    description: 'List all files currently in the workspace (relative paths).',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'run_tests',
    description:
      'Run the workspace test suite (npm test) and return whether it passed plus the full test output. Use this to verify your changes and iterate on failures.',
    parameters: { type: 'object', properties: {}, required: [] }
  }
]

const registry: Record<string, CodingExecutor> = {
  write_file,
  read_file,
  list_files,
  run_tests
}

/**
 * Execute a coding tool by name. Never throws — mirrors executeTool in tools.ts
 * so the autonomous loop can feed failures back to the model.
 */
export async function executeCodingTool(
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const fn = registry[name]
  if (!fn) return { ok: false, error: `Unknown coding tool "${name}".` }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { ok: false, error: `Invalid arguments for "${name}": expected an object.` }
  }
  try {
    return await fn(args)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Short human-readable label for a coding tool call, shown in the task UI. */
export function describeCodingToolCall(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'write_file':
      return `Write ${String(args.path ?? 'file')}`
    case 'read_file':
      return `Read ${String(args.path ?? 'file')}`
    case 'list_files':
      return 'List workspace files'
    case 'run_tests':
      return 'Run npm test'
    default:
      return name
  }
}
