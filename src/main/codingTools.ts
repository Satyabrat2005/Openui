/**
 * codingTools.ts — the tool surface for the autonomous coding agent (Phase 8).
 *
 * These are deliberately SEPARATE from the OS-automation tools in tools.ts. The
 * interactive desktop assistant can move the mouse, launch apps and read the
 * screen; the unattended coding agent must not. It only ever touches files
 * inside the sandbox workspace, searches them, commits them to a local git repo,
 * and runs the workspace's own test/build scripts. Keeping the two registries
 * apart means a task/issue that tries to steer the coding agent into clicking
 * around the desktop simply has no such tool to call.
 *
 * There is deliberately NO general "run this shell command" tool. sandbox.ts
 * holds its containment guarantee because every command it runs is either
 * static (`npm test`) or an allowlisted argv array launched without a shell. A
 * free-form command tool would hand arbitrary code execution to whatever text
 * steers this agent — which, for the autonomous runner, is a task description or
 * a GitHub issue body written by someone else.
 *
 * Schemas reuse the ToolSchema/ToolResult shapes from tools.ts so they render
 * into the system prompt with the same renderer the interactive agent uses.
 */
import { shell } from 'electron'
import {
  writeSandboxFile,
  readSandboxFile,
  editSandboxFile,
  applyPatchToSandboxFile,
  searchSandbox,
  listSandboxFiles,
  getWorkspaceDir,
  resolveSandboxPath,
  runTests,
  runInstall,
  runScript,
  runPytest,
  runPythonScript,
  runCppProgram,
  runGit
} from './sandbox'
import { maybeOpenEditorOnFirstWrite } from './editor'
import { snapshotBeforeWrite } from './snapshots'
import { reindexFileInCodebase, searchCodebaseSemantic } from './codebaseIndex'
import { updateCodebaseMapForFile, findDefinition, findUsages } from './codebaseMap'

/**
 * Keep the derived views of the workspace current after a file changes: the
 * semantic index (Task §1) and the symbol/dependency map (Task §2). Both are
 * fire-and-forget and self-degrading — a missing native module or a downed
 * Ollama makes the index a no-op — so they never block or fail the triggering
 * write.
 */
function onFileMutated(path: string): void {
  void reindexFileInCodebase(path)
  void updateCodebaseMapForFile(path)
}
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
    // Bring the project up in an editor the first time a session writes, so the
    // user watches the files land. Not awaited: launching a GUI must not sit in
    // front of the write's result.
    void maybeOpenEditorOnFirstWrite(getWorkspaceDir())
    onFileMutated(path)
    return { ok: true, output: `Wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${written}.` }
  } catch (err) {
    return { ok: false, error: `write_file failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/**
 * Open a workspace file (typically an HTML entry point) in the user's default
 * browser/app so they can see the result of a build. This is the builder
 * session's only way to show a preview — without it the model has no tool to
 * fulfil "open it in my browser" and either hallucinates one or gives up.
 */
async function open_in_browser(args: Record<string, unknown>): Promise<ToolResult> {
  const path = typeof args.path === 'string' ? args.path : ''
  if (!path) return { ok: false, error: 'open_in_browser requires a string "path".' }
  try {
    const abs = await resolveSandboxPath(path)
    const err = await shell.openPath(abs)
    if (err) return { ok: false, error: `open_in_browser failed: ${err}` }
    return { ok: true, output: `Opened ${path} in your default browser/app.` }
  } catch (err) {
    return { ok: false, error: `open_in_browser failed: ${err instanceof Error ? err.message : String(err)}` }
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

async function edit_file(args: Record<string, unknown>): Promise<ToolResult> {
  const path = typeof args.path === 'string' ? args.path : ''
  if (!path) return { ok: false, error: 'edit_file requires a string "path".' }
  if (typeof args.old_string !== 'string' || args.old_string === '') {
    return { ok: false, error: 'edit_file requires a non-empty string "old_string".' }
  }
  if (typeof args.new_string !== 'string') {
    return {
      ok: false,
      error: 'edit_file requires a string "new_string" (pass "" to delete the matched text).'
    }
  }
  const replaceAll = args.replace_all === true
  try {
    // Same rollback contract as write_file: capture the pre-image before the
    // first mutation of this file within a snapshot transaction.
    await snapshotBeforeWrite(path)
    const result = await editSandboxFile(path, args.old_string, args.new_string, replaceAll)
    void maybeOpenEditorOnFirstWrite(getWorkspaceDir())
    onFileMutated(path)
    const plural = result.replacements === 1 ? '' : 's'
    return { ok: true, output: `Replaced ${result.replacements} occurrence${plural} in ${result.path}.` }
  } catch (err) {
    return { ok: false, error: `edit_file failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function apply_patch(args: Record<string, unknown>): Promise<ToolResult> {
  const path = typeof args.path === 'string' ? args.path : ''
  const diff = typeof args.diff === 'string' ? args.diff : ''
  if (!path) return { ok: false, error: 'apply_patch requires a string "path".' }
  if (!diff) {
    return { ok: false, error: 'apply_patch requires a string "diff" (a unified diff with @@ hunks).' }
  }
  try {
    // Same rollback contract as edit_file: snapshot the pre-image before the
    // first mutation of this file within a snapshot transaction.
    await snapshotBeforeWrite(path)
    const result = await applyPatchToSandboxFile(path, diff)
    void maybeOpenEditorOnFirstWrite(getWorkspaceDir())
    onFileMutated(path)
    const plural = result.hunks === 1 ? '' : 'es'
    return { ok: true, output: `Applied ${result.hunks} hunk${plural} to ${result.path}.` }
  } catch (err) {
    return { ok: false, error: `apply_patch failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function search_code(args: Record<string, unknown>): Promise<ToolResult> {
  const pattern = typeof args.pattern === 'string' ? args.pattern : ''
  if (!pattern) {
    return { ok: false, error: 'search_code requires a string "pattern" (a regular expression).' }
  }
  const glob = typeof args.glob === 'string' && args.glob.trim() ? args.glob : undefined
  const maxResults = typeof args.max_results === 'number' ? args.max_results : undefined
  const ignoreCase = args.ignore_case === true
  try {
    const matches = await searchSandbox(pattern, { glob, maxResults, ignoreCase })
    if (!matches.length) {
      return { ok: true, output: `No matches for /${pattern}/${glob ? ` in ${glob}` : ''}.` }
    }
    const rendered = matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join('\n')
    const plural = matches.length === 1 ? '' : 'es'
    return { ok: true, output: `${matches.length} match${plural}:\n${rendered}` }
  } catch (err) {
    return { ok: false, error: `search_code failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function search_codebase_semantic(args: Record<string, unknown>): Promise<ToolResult> {
  const query = typeof args.query === 'string' ? args.query : ''
  if (!query.trim()) {
    return { ok: false, error: 'search_codebase_semantic requires a string "query".' }
  }
  const topK = typeof args.top_k === 'number' && args.top_k > 0 ? Math.min(args.top_k, 20) : 6
  // A red result here is not an error — degrade to the grep baseline so the loop
  // keeps moving when embeddings/the native index are unavailable.
  const result = await searchCodebaseSemantic(query, topK)
  if (!result.ok) {
    return {
      ok: true,
      output:
        'Semantic codebase search is unavailable ' +
        `(${result.reason ?? 'not ready'}). Use search_code (regex grep) instead.`
    }
  }
  if (!result.results.length) {
    return { ok: true, output: `No semantically relevant code for "${query}". Try search_code.` }
  }
  const rendered = result.results
    .map((r) => `${r.source} (score ${r.score})\n${r.text}`)
    .join('\n\n---\n')
  return { ok: true, output: `Top ${result.results.length} matches for "${query}":\n\n${rendered}` }
}

async function find_definition(args: Record<string, unknown>): Promise<ToolResult> {
  const symbol = typeof args.symbol === 'string' ? args.symbol.trim() : ''
  if (!symbol) return { ok: false, error: 'find_definition requires a string "symbol".' }
  try {
    const result = await findDefinition(symbol)
    if (!result.ok) {
      return { ok: true, output: `No declaration of "${symbol}" found in the symbol map. Try search_code.` }
    }
    const rendered = result.defs
      .map((d) => `${d.file}:${d.line} (${d.kind})${d.snippet ? `\n${d.snippet}` : ''}`)
      .join('\n\n')
    return { ok: true, output: `Definition(s) of "${symbol}":\n\n${rendered}` }
  } catch (err) {
    return { ok: false, error: `find_definition failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function find_usages(args: Record<string, unknown>): Promise<ToolResult> {
  const symbol = typeof args.symbol === 'string' ? args.symbol.trim() : ''
  if (!symbol) return { ok: false, error: 'find_usages requires a string "symbol".' }
  try {
    const result = await findUsages(symbol)
    const header = result.note ? `${result.note}\n\n` : ''
    if (!result.usages.length) {
      return { ok: true, output: `${header}No usages of "${symbol}" found outside its declaration.` }
    }
    const rendered = result.usages.map((u) => `${u.file}:${u.line}: ${u.text}`).join('\n')
    return { ok: true, output: `${header}Usages of "${symbol}" (${result.usages.length}):\n${rendered}` }
  } catch (err) {
    return { ok: false, error: `find_usages failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function git(args: Record<string, unknown>): Promise<ToolResult> {
  const subcommand = typeof args.subcommand === 'string' ? args.subcommand : ''
  if (!subcommand) return { ok: false, error: 'git requires a string "subcommand".' }
  // runGit re-validates every element; this only shapes the value for its signature.
  const gitArgs = Array.isArray(args.args) ? (args.args as string[]) : []
  try {
    // Like run_tests: a refused or failing git call is information for the model,
    // not a tool error to blindly retry.
    const result = await runGit(subcommand, gitArgs)
    return {
      ok: true,
      output: `${result.passed ? 'GIT OK' : 'GIT FAILED'} [${subcommand}]\n${result.output || '(no output)'}`
    }
  } catch (err) {
    return { ok: false, error: `git failed: ${err instanceof Error ? err.message : String(err)}` }
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
    //
    // TESTS SKIPPED is a third, distinct marker for "this project has no suite
    // to run at all" — see runTests. It must not read as FAILED: on a project
    // type where having nothing to test is legitimate (a static site), the
    // profile maps this marker to a pass so a finished build can end without
    // being nudged toward a suite that cannot exist.
    const marker = result.skipped ? 'TESTS SKIPPED' : result.passed ? 'TESTS PASSED' : 'TESTS FAILED'
    return { ok: true, output: `${marker}\n${result.output}` }
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
    // SCRIPT SKIPPED mirrors TESTS SKIPPED: "this project has nothing to run",
    // which is the absence of a verdict rather than a red one. See runScript.
    const marker = result.skipped ? 'SCRIPT SKIPPED' : result.passed ? 'SCRIPT OK' : 'SCRIPT FAILED'
    return { ok: true, output: `${marker} [${script}]\n${result.output}` }
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
    name: 'open_in_browser',
    description:
      'Open a workspace file (e.g. an HTML page) in the user\'s default browser so they can see it. ' +
      'Use this at the end of a build when the user asked to see/open/preview the result — e.g. ' +
      'call it with "index.html" right after writing a web page.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file to open, e.g. "index.html".' }
      },
      required: ['path']
    }
  },
  {
    name: 'edit_file',
    description:
      'Change part of an existing workspace file by replacing an exact snippet of text. ' +
      'PREFER THIS OVER write_file for any change to a file that already exists — write_file ' +
      'overwrites the whole file, so using it to tweak a few lines silently deletes everything ' +
      'you did not retype. "old_string" is matched literally (not as a regex) and must appear ' +
      'exactly once: include the surrounding lines needed to make it unique, and reproduce the ' +
      'indentation byte-for-byte. To delete text, pass an empty "new_string".',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path, e.g. "src/index.js".' },
        old_string: {
          type: 'string',
          description: 'Exact existing text to replace, including indentation. Must be unique in the file.'
        },
        new_string: { type: 'string', description: 'Replacement text. Empty string deletes the match.' },
        replace_all: {
          type: 'boolean',
          description: 'Replace every occurrence instead of requiring a unique match (default false).'
        }
      },
      required: ['path', 'old_string', 'new_string']
    }
  },
  {
    name: 'apply_patch',
    description:
      'Apply a unified diff to ONE existing workspace file. Use this instead of several edit_file ' +
      'calls when a single file needs changes in several places — all the hunks land in one call, ' +
      'saving turns. "diff" is a standard unified diff: one or more "@@ -old,len +new,len @@" hunks ' +
      'whose context and removed (" " and "-") lines must still match the file, followed by added ' +
      '("+") lines. Any "---"/"+++" header lines are ignored (the file comes from "path"). Line ' +
      'numbers may drift, but if the surrounding context no longer matches the patch is rejected — ' +
      're-read the file and regenerate the hunk rather than retrying blindly.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path, e.g. "src/index.js".' },
        diff: {
          type: 'string',
          description:
            'Unified diff body with at least one "@@ ... @@" hunk. Prefix context lines with a space, ' +
            'removed lines with "-", added lines with "+".'
        }
      },
      required: ['path', 'diff']
    }
  },
  {
    name: 'search_code',
    description:
      'Search the workspace for a regular expression and return matching lines as "file:line: text". ' +
      'Use this to find where something is defined or used BEFORE reading or editing files — it is how ' +
      'you navigate code you did not write in this session, instead of guessing at paths. ' +
      'Binary files, node_modules and dot-directories are skipped.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'JavaScript regular expression, e.g. "function\\\\s+createUser" or "TODO".'
        },
        glob: {
          type: 'string',
          description: 'Optional path filter, e.g. "src/**/*.ts" or "*.py". Supports *, ** and ?.'
        },
        ignore_case: { type: 'boolean', description: 'Case-insensitive match (default false).' },
        max_results: { type: 'number', description: 'Cap on returned matches (default 100).' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'search_codebase_semantic',
    description:
      'Find code by MEANING, not by literal text. Ask a natural-language question — ' +
      '"where is the auth token refreshed?", "how are snapshots restored?" — and get back the most ' +
      'semantically relevant source chunks, ranked. Use this FIRST on an unfamiliar codebase to locate ' +
      'the right area, then read_file or search_code to zoom in. It complements search_code (exact ' +
      'regex): reach for this when you know WHAT you want but not the exact identifier. If the index ' +
      'is unavailable it will tell you to use search_code instead.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'A natural-language description of the code you are looking for.'
        },
        top_k: { type: 'number', description: 'How many chunks to return (default 6, max 20).' }
      },
      required: ['query']
    }
  },
  {
    name: 'find_definition',
    description:
      'Jump to where a symbol is DECLARED using the prebuilt symbol map — function, class, const, ' +
      'interface, type or enum. Returns file:line plus a short snippet, without grepping the whole ' +
      'tree. Use this before editing or renaming a symbol you did not define in this session. Falls ' +
      'back to a hint to use search_code when the symbol is not in the map.',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Exact identifier to locate, e.g. "refreshToken".' }
      },
      required: ['symbol']
    }
  },
  {
    name: 'find_usages',
    description:
      'List where a symbol is REFERENCED across the workspace (word-boundary matches, excluding its ' +
      'own declaration), annotated with which files import the file that defines it. Use this to scope ' +
      'a multi-file refactor — see every call site before you change a signature.',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Exact identifier to find references to.' }
      },
      required: ['symbol']
    }
  },
  {
    name: 'git',
    description:
      'Run a local git command in the workspace repository. Use it to initialise a repo ("init"), ' +
      'stage and commit your work as you go ("add", "commit"), inspect what you changed ("status", ' +
      '"diff", "log"), and work on branches ("branch", "checkout", "switch", "restore"). ' +
      'Commit after each coherent, verified change so the work is reviewable and revertable. ' +
      'Network commands (push, pull, fetch, clone, remote) are NOT available — publishing is a ' +
      'separate, human-approved step.',
    parameters: {
      type: 'object',
      properties: {
        subcommand: {
          type: 'string',
          description:
            'One of: init, status, add, commit, diff, log, show, branch, checkout, switch, restore, rev-parse, stash, tag, mv, rm.'
        },
        args: {
          type: 'array',
          description:
            'Arguments passed to git verbatim, e.g. ["-m", "Add user login"] for commit, or ["--oneline", "-n", "10"] for log. ' +
            'No shell is involved, so quoting is unnecessary — pass each argument as its own element.'
        }
      },
      required: ['subcommand']
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
  open_in_browser,
  edit_file,
  apply_patch,
  search_code,
  search_codebase_semantic,
  find_definition,
  find_usages,
  git,
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
 */
export function mutatesWorkspace(name: string, args: Record<string, unknown>): boolean {
  if (name === 'write_file' || name === 'edit_file' || name === 'apply_patch') return true
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
    case 'edit_file':
      return `Edit ${String(args.path ?? 'file')}`
    case 'apply_patch':
      return `Patch ${String(args.path ?? 'file')}`
    case 'search_code':
      return `Search for "${String(args.pattern ?? '')}"${args.glob ? ` in ${String(args.glob)}` : ''}`
    case 'search_codebase_semantic':
      return `Semantic search: "${String(args.query ?? '')}"`
    case 'find_definition':
      return `Find definition of ${String(args.symbol ?? '')}`
    case 'find_usages':
      return `Find usages of ${String(args.symbol ?? '')}`
    case 'git': {
      const rest = Array.isArray(args.args) ? args.args.filter((a) => typeof a === 'string') : []
      return `git ${String(args.subcommand ?? '')}${rest.length ? ` ${rest.join(' ')}` : ''}`.trim()
    }
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
