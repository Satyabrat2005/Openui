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
import {
  writeSandboxFile,
  readSandboxFile,
  listSandboxFiles,
  runTests,
  runInstall,
  runScript,
  runPytest,
  runPythonScript,
  runCppProgram
} from './sandbox'
import { snapshotBeforeWrite } from './snapshots'
import type { ToolSchema, ToolResult } from './tools'

type CodingExecutor = (args: Record<string, unknown>) => Promise<ToolResult>

async function write_file(args: Record<string, unknown>): Promise<ToolResult> {
  const path = typeof args.path === 'string' ? args.path : ''
  const content = typeof args.content === 'string' ? args.content : ''
  if (!path) return { ok: false, error: 'write_file requires a string "path".' }
  try {
    // Rollback safety (Task 5): capture the pre-image before the first write to
    // each file so a failed task can restore the workspace. No-op outside a
    // snapshot transaction (interactive writes).
    await snapshotBeforeWrite(path)
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

async function install_dependencies(): Promise<ToolResult> {
  try {
    const result = await runInstall()
    // Like run_tests: always ok:true so the model reads the log and decides the
    // next step rather than treating a normal install failure as a tool error.
    return {
      ok: true,
      output: `${result.passed ? 'INSTALL OK' : 'INSTALL FAILED'}\n${result.output}`
    }
  } catch (err) {
    return {
      ok: false,
      error: `install_dependencies failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

// The three non-npm verifiers below follow the run_tests convention: always
// ok:true with a PASSED/FAILED marker prefix, so the model reads the log and
// iterates instead of treating a normal red run as a retryable tool error.

async function run_pytest(): Promise<ToolResult> {
  try {
    const result = await runPytest()
    return {
      ok: true,
      output: `${result.passed ? 'PYTEST PASSED' : 'PYTEST FAILED'}\n${result.output}`
    }
  } catch (err) {
    return { ok: false, error: `run_pytest failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function run_python(args: Record<string, unknown>): Promise<ToolResult> {
  const path = typeof args.path === 'string' ? args.path : ''
  const smoke = args.smoke !== false // default true — unattended runs must stay fast
  if (!path) return { ok: false, error: 'run_python requires a string "path" (a workspace .py file).' }
  try {
    const result = await runPythonScript(path, smoke)
    return {
      ok: true,
      output: `${result.passed ? 'PYTHON RUN OK' : 'PYTHON RUN FAILED'} [${path}${smoke ? ' --smoke' : ''}]\n${result.output}`
    }
  } catch (err) {
    return { ok: false, error: `run_python failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function run_cpp(args: Record<string, unknown>): Promise<ToolResult> {
  const path = typeof args.path === 'string' ? args.path : ''
  const input = typeof args.input === 'string' ? args.input : ''
  if (!path) return { ok: false, error: 'run_cpp requires a string "path" (a workspace .cpp file).' }
  try {
    const result = await runCppProgram(path, input)
    return {
      ok: true,
      output: `${result.passed ? 'CPP RUN OK' : 'CPP RUN FAILED'} [${path}]\n${result.output}`
    }
  } catch (err) {
    return { ok: false, error: `run_cpp failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function run_script(args: Record<string, unknown>): Promise<ToolResult> {
  const script = typeof args.script === 'string' ? args.script : ''
  if (!script) return { ok: false, error: 'run_script requires a string "script".' }
  try {
    const result = await runScript(script)
    return {
      ok: true,
      output: `${result.passed ? 'SCRIPT OK' : 'SCRIPT FAILED'} [${script}]\n${result.output}`
    }
  } catch (err) {
    return {
      ok: false,
      error: `run_script failed: ${err instanceof Error ? err.message : String(err)}`
    }
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
  },
  {
    name: 'install_dependencies',
    description:
      'Run "npm install" in the workspace to install the dependencies declared in package.json. ' +
      'Call this after writing package.json (and before running a build/dev/test script) for any project that has dependencies.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'run_script',
    description:
      'Run a named npm script from the workspace ("npm run <script>") — e.g. "build", "train", "lint", or "dev". ' +
      'The script must already be defined in the workspace package.json. ' +
      'Long-running scripts (dev/start/serve/watch/preview) are run as a boot smoke test: they are started, checked for a crash, then stopped. ' +
      'One-shot scripts (build/train/lint) run to completion and return their full output. ' +
      'Use this to build or train the project and iterate on failures the same way you would with run_tests.',
    parameters: {
      type: 'object',
      properties: {
        script: {
          type: 'string',
          description: 'The npm script name to run, as declared in package.json (e.g. "build").'
        }
      },
      required: ['script']
    }
  },
  {
    name: 'run_pytest',
    description:
      'Run the workspace Python test suite ("python -m pytest -q") and return whether it passed plus the output. ' +
      'Use this to verify Python (ML/DL) work the same way run_tests verifies npm work.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'run_python',
    description:
      'Run a Python script from the workspace. By default it is run with the "--smoke" flag ' +
      '(your scripts must support a fast smoke mode: tiny data subset, CPU-only, finishes in seconds). ' +
      'Set smoke to false only for scripts that are inherently quick. Returns PYTHON RUN OK/FAILED plus the output.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative .py file, e.g. "train.py".' },
        smoke: {
          type: 'boolean',
          description: 'Pass --smoke to the script (default true). Set false only for quick scripts.'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'run_cpp',
    description:
      'Compile a single C++17 source file from the workspace with g++ and run the binary with the given stdin. ' +
      'Use this to verify competitive-programming solutions against sample inputs: pass the sample input as "input" ' +
      'and compare the printed output with the expected sample output yourself.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative .cpp file, e.g. "main.cpp".' },
        input: { type: 'string', description: 'Text fed to the program on stdin (e.g. the sample input).' }
      },
      required: ['path']
    }
  }
]

const registry: Record<string, CodingExecutor> = {
  write_file,
  read_file,
  list_files,
  run_tests,
  install_dependencies,
  run_script,
  run_pytest,
  run_python,
  run_cpp
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

/**
 * git subcommands that rewrite the working tree. `add` and `commit` only move
 * content into the index/history, so they leave the files the verifier ran
 * against exactly as they were.
 */
const GIT_TREE_MUTATING = new Set(['checkout', 'switch', 'restore', 'rm', 'mv', 'stash'])

/**
 * True when a SUCCESSFUL call to this tool changed the workspace source tree.
 *
 * A passing verifier is a statement about the tree as it stood when the verifier
 * ran. The moment a file changes, that statement expires — so the coding loop
 * uses this to drop a stale "tests passed" rather than let the model edit after
 * a green run and then declare victory.
 *
 * Names beyond the coding agent's current tool set (edit_file, git) are matched
 * defensively so the rule stays correct if those tools are added later.
 */
export function mutatesWorkspace(name: string, args: Record<string, unknown>): boolean {
  if (name === 'write_file' || name === 'edit_file') return true
  if (name === 'git') {
    const sub = typeof args.subcommand === 'string' ? args.subcommand.trim() : ''
    return GIT_TREE_MUTATING.has(sub)
  }
  return false
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
    case 'install_dependencies':
      return 'Install dependencies (npm install)'
    case 'run_script':
      return `Run npm script "${String(args.script ?? '')}"`
    case 'run_pytest':
      return 'Run pytest'
    case 'run_python':
      return `Run python ${String(args.path ?? '')}${args.smoke === false ? '' : ' --smoke'}`
    case 'run_cpp':
      return `Compile & run ${String(args.path ?? '')}`
    default:
      return name
  }
}
