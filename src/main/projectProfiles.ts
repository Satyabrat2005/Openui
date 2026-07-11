/**
 * projectProfiles.ts — project-type branching for the autonomous coding loop
 * (Task 3). The loop used to assume every task is a Node/npm project and verify
 * everything with `npm test`; that breaks the moment a task says "train a
 * classifier" or "solve this Codeforces problem". This module classifies a task
 * into one of five project types and gives the loop, per type:
 *
 *   - a prompt addendum (how to structure the project, how to verify it),
 *   - a task-prompt hint (what "done" means for this kind of work),
 *   - a verdict function mapping (tool, output) → pass/fail/not-a-verification,
 *     so the loop's success signal keys off the RIGHT tool for the type
 *     (run_cpp for competitive programming, run_pytest/run_python for ML/DL,
 *     npm test / scripts for web and Node work).
 *
 * Detection is a keyword heuristic over the task title+description. It is
 * deliberately conservative: anything ambiguous falls back to 'node', which is
 * exactly the loop's old behaviour.
 */

export type ProjectType = 'website' | 'node' | 'ml' | 'dl' | 'cp'

export interface ProjectProfile {
  type: ProjectType
  /** Short label for logs and the status UI, e.g. "deep learning". */
  label: string
  /** Appended to the coding system prompt — type-specific workflow guidance. */
  promptAddendum: string
  /** Appended to the task prompt — what verification to drive toward. */
  taskHint: string
  /**
   * The tool names that COUNT as verification for this project type. Same set
   * the verdict function recognises; named separately so the loop can tell the
   * model which tool to run when it tries to finish without verifying.
   */
  verifiers: readonly string[]
  /**
   * Classify one tool result for this project type: 'pass'/'fail' when the tool
   * IS this type's verification step, null when it isn't one. The loop keeps
   * the latest non-null verdict as its success signal.
   */
  verdict(tool: string, output: string): 'pass' | 'fail' | null
}

// Keyword patterns per type, tested against the lowercased title+description.
// Order matters: cp and dl are the most specific, node is the fallback.
const CP_RE =
  /\b(competitive programming|codeforces|leetcode|atcoder|hackerrank|codechef|single[- ]file|stdin|stdout|time limit|algorithm problem|problem statement)\b/
const DL_RE =
  /\b(deep learning|neural network|pytorch|torch|tensorflow|keras|cnn|rnn|lstm|transformer|embedding|gpu|cuda|epochs?|backprop\w*|fine[- ]?tun\w+)\b/
const ML_RE =
  /\b(machine learning|scikit|sklearn|pandas|numpy|regression|classifier|classification|clustering|random forest|xgboost|dataset|train(?:ing)? (?:a |the )?model|feature engineering)\b/
const WEBSITE_RE =
  /\b(website|web ?site|landing page|web ?page|web ?app|frontend|front[- ]end|html|css|portfolio site|blog site|react|vue|svelte|next\.?js|vite|tailwind)\b/

/**
 * Classify a task by its title + description. Most-specific wins:
 * cp → dl → ml → website → node (the old default).
 */
export function detectProjectType(title: string, description?: string): ProjectType {
  const text = `${title}\n${description ?? ''}`.toLowerCase()
  if (CP_RE.test(text)) return 'cp'
  if (DL_RE.test(text)) return 'dl'
  if (ML_RE.test(text)) return 'ml'
  if (WEBSITE_RE.test(text)) return 'website'
  return 'node'
}

/**
 * Verdict helper: PASS when the tool's output starts with its pass marker.
 * Returns BOTH halves of the verification contract from one map, so the list of
 * verifier names can never drift out of sync with the function that judges them.
 * Spread into a profile: `...markerVerdict({ run_tests: { pass: 'TESTS PASSED' } })`.
 */
function markerVerdict(tools: Record<string, { pass: string }>): {
  verifiers: readonly string[]
  verdict: (tool: string, output: string) => 'pass' | 'fail' | null
} {
  return {
    verifiers: Object.keys(tools),
    verdict: (tool, output) => {
      const spec = tools[tool]
      if (!spec) return null
      return output.startsWith(spec.pass) ? 'pass' : 'fail'
    }
  }
}

const PYTHON_ADDENDUM_SHARED = `- Write a requirements.txt, but assume common libraries may already be installed; import errors in the output tell you what is missing.
- Every training script MUST support a "--smoke" flag that runs the full pipeline on a tiny subset (seconds, CPU-only) — that is how your work is verified here. Never claim results you did not produce in this workspace.
- Put reusable logic (data prep, model factory, metrics) in functions/modules and write pytest tests for them in test_*.py files.
- Verify with run_pytest (unit tests) AND run_python on the training script with smoke=true (end-to-end).`

const PROFILES: Record<ProjectType, ProjectProfile> = {
  node: {
    type: 'node',
    label: 'Node.js project',
    promptAddendum: `PROJECT TYPE: Node.js. Standard npm workflow — write package.json with a "test" script, install dependencies, and verify with run_tests until it passes.`,
    taskHint: 'Complete this task in the workspace, then run the tests until they pass.',
    ...markerVerdict({ run_tests: { pass: 'TESTS PASSED' } })
  },
  website: {
    type: 'website',
    label: 'website scaffold',
    promptAddendum: `PROJECT TYPE: website. Guidance:
- For a simple site, plain HTML/CSS/JS files are better than a framework — no build step to break. Make index.html complete and self-contained where possible.
- If the task needs a framework, scaffold it fully (package.json with dev/build scripts, config, source) and call install_dependencies before any script.
- Verify your work: with a package.json, run_script "build" (or "dev" as a boot smoke test) or run_tests if you wrote tests. A plain static site with no package.json cannot be executed here — in that case make read_file/list_files checks and say clearly in your summary that the site is static and was not smoke-run.`,
    taskHint:
      'Build the site in the workspace. Verify it: run the build/dev script (or tests) if it has a package.json.',
    ...markerVerdict({
      run_tests: { pass: 'TESTS PASSED' },
      run_script: { pass: 'SCRIPT OK' }
    })
  },
  ml: {
    type: 'ml',
    label: 'ML training script',
    promptAddendum: `PROJECT TYPE: machine learning (Python). Guidance:
- Use Python with scikit-learn/pandas/numpy. Entry point: train.py.
- If the task names no dataset, generate or download a small standard one in code (e.g. sklearn built-ins) so the script is runnable end-to-end.
${PYTHON_ADDENDUM_SHARED}`,
    taskHint:
      'Implement the ML task in Python. Verify with run_pytest and a run_python smoke run of the training script until both pass.',
    ...markerVerdict({
      run_pytest: { pass: 'PYTEST PASSED' },
      run_python: { pass: 'PYTHON RUN OK' }
    })
  },
  dl: {
    type: 'dl',
    label: 'deep-learning project',
    promptAddendum: `PROJECT TYPE: deep learning (Python). Guidance:
- Use PyTorch unless the task names another framework. Entry point: train.py; keep the model in model.py.
- Default to CPU. The "--smoke" mode must cap the run (e.g. 1 epoch, few batches, tiny model) so it finishes in seconds without a GPU.
${PYTHON_ADDENDUM_SHARED}`,
    taskHint:
      'Implement the deep-learning task in Python. Verify with run_pytest and a run_python smoke run of the training script until both pass.',
    ...markerVerdict({
      run_pytest: { pass: 'PYTEST PASSED' },
      run_python: { pass: 'PYTHON RUN OK' }
    })
  },
  cp: {
    type: 'cp',
    label: 'competitive programming',
    promptAddendum: `PROJECT TYPE: competitive programming. Guidance:
- Write ONE self-contained C++17 file, main.cpp, reading from stdin and writing to stdout. No external dependencies.
- Mind the stated constraints: pick an algorithm whose complexity fits the input bounds before coding.
- Verify with run_cpp, passing the problem's sample input as "input" — compare the printed output to the expected sample output yourself. Test edge cases (smallest/largest inputs) the same way.
- If the samples don't match, fix main.cpp and re-run. Do not just restate the expected answer; the program must produce it.`,
    taskHint:
      'Solve the problem in a single main.cpp. Verify with run_cpp against the sample input(s) until the output matches.',
    ...markerVerdict({ run_cpp: { pass: 'CPP RUN OK' } })
  }
}

export function getProjectProfile(type: ProjectType): ProjectProfile {
  return PROFILES[type]
}
