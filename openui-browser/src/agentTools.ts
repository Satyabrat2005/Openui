// The web agent's tool surface — the schemas the model is shown, and the system
// prompt that frames the tool-calling convention. This is the web equivalent of
// the desktop `allSchemas`/`renderSchema`/`buildDefaultSystemPrompt` in agent.ts,
// deliberately SCOPED to exactly the tools `runTool` implements. A tool that is
// not runnable must never appear here (the desktop lesson: schemas for tools the
// caller can't execute are dead weight that only invite the model to call a
// dead end). The same JSON convention as desktop: the model replies with ONLY a
// raw `{"tool":"…","args":{…}}` object; `toolCallParser.ts` recovers it.

export interface ToolSchema {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, { type: string; description: string; enum?: string[]; items?: unknown }>
    required: string[]
  }
}

// The implemented web tool surface. Kept in lock-step with `runTool` in
// server.ts — see the WEB_TOOL_NAMES export the server asserts against at boot.
export const WEB_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'write_spreadsheet',
    description:
      'Create an .xlsx workbook (a tracker, budget, table, report, list of numbers, etc.). Each sheet has optional headers and rows.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'File name (without extension), e.g. "Q3 Tracker".' },
        sheets: {
          type: 'array',
          description:
            'Sheets to write. Each: {"name":"Sheet1","headers":["Col A","Col B"],"rows":[["a",1],["b",2]]}. Cell values are strings or numbers.',
          items: { type: 'object', description: 'A sheet spec.' }
        }
      },
      required: ['title', 'sheets']
    }
  },
  {
    name: 'create_document',
    description: 'Create a real Microsoft Word .docx document from a title and paragraphs.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Document title (becomes the level-1 heading).' },
        paragraphs: {
          type: 'array',
          description: 'Body paragraphs, in order. Each item is one paragraph of plain text.',
          items: { type: 'string', description: 'A paragraph.' }
        }
      },
      required: ['title', 'paragraphs']
    }
  },
  {
    name: 'create_pdf',
    description: 'Create a .pdf from a title and an ordered list of content blocks.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'PDF title (rendered as the first heading).' },
        content: {
          type: 'array',
          description:
            'Ordered blocks. Each is a string (paragraph) or an object: {"heading":"…","level":1}, {"paragraph":"…"}, {"bullets":["a","b"]}, {"rows":[["h1","h2"],["a","b"]]}, or {"page_break":true}.',
          items: { type: 'object', description: 'A content block.' }
        }
      },
      required: ['title', 'content']
    }
  },
  {
    name: 'create_presentation',
    description: 'Create a .pptx slide deck from a title slide plus content slides.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Deck title (the opening title slide).' },
        slides: {
          type: 'array',
          description:
            'Content slides after the title slide. Each: {"heading":"Agenda","bullets":["Point 1","Point 2"],"subtitle":"optional"}.',
          items: { type: 'object', description: 'A slide spec.' }
        }
      },
      required: ['title', 'slides']
    }
  },
  {
    name: 'search_papers',
    description:
      'Search academic papers (arXiv, then Semantic Scholar) and return titles, authors, abstracts, and PDF links. Read-only; nothing is downloaded.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query, e.g. "graph neural networks".' },
        max_results: { type: 'number', description: 'How many papers to return (1–10, default 4).' }
      },
      required: ['query']
    }
  },
  {
    name: 'download_paper',
    description: 'Download a single paper PDF from an https:// URL (e.g. a PDF link returned by search_papers).',
    parameters: {
      type: 'object',
      properties: {
        pdf_url: { type: 'string', description: 'The https:// URL of the PDF to download.' }
      },
      required: ['pdf_url']
    }
  },
  {
    name: 'create_repo',
    description: 'Create a new GitHub repository. Requires a connected GitHub token.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Short repo description.' },
        private: { type: 'string', description: 'Whether the repo is private ("true"/"false"). Defaults to private.' }
      },
      required: ['name']
    }
  },
  {
    name: 'update_readme',
    description: 'Create or replace README.md on a GitHub repo. Requires a connected GitHub token.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Target repo as "owner/repo".' },
        content: { type: 'string', description: 'The full markdown content for README.md.' },
        message: { type: 'string', description: 'Commit message (optional).' }
      },
      required: ['repo', 'content']
    }
  },
  {
    name: 'push_files',
    description:
      'Push a set of files to a GitHub branch as one commit (blobs → tree → commit → ref). Creates the branch off the default branch if it does not exist. Requires a connected GitHub token.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Target repo as "owner/repo".' },
        files: {
          type: 'object',
          description: 'Object mapping repo-relative paths to file contents, e.g. {"src/index.js":"…","README.md":"…"}.'
        },
        branch: { type: 'string', description: 'Target branch (optional; defaults to "openui").' },
        message: { type: 'string', description: 'Commit message (optional).' }
      },
      required: ['repo', 'files']
    }
  },
  {
    name: 'open_pull_request',
    description: 'Open a pull request on a GitHub repo. Requires a connected GitHub token.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Target repo as "owner/repo".' },
        title: { type: 'string', description: 'PR title.' },
        head: { type: 'string', description: 'Source branch (optional; defaults to "openui").' },
        base: { type: 'string', description: 'Target branch (optional; defaults to the repo default branch).' },
        body: { type: 'string', description: 'PR description (optional).' }
      },
      required: ['repo', 'title']
    }
  },
  {
    name: 'merge_pr',
    description:
      'Merge an open pull request. This is DESTRUCTIVE/irreversible — only call it when the user explicitly asked to merge. Requires a connected GitHub token.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Target repo as "owner/repo".' },
        pr_number: { type: 'number', description: 'The pull request number to merge.' },
        method: { type: 'string', description: 'Merge method.', enum: ['merge', 'squash', 'rebase'] }
      },
      required: ['repo', 'pr_number']
    }
  }
]

/** The set of tool names the agent may call — asserted against runTool at boot. */
export const WEB_TOOL_NAMES: Set<string> = new Set(WEB_TOOL_SCHEMAS.map((s) => s.name))

/** Render one schema as a compact signature line — verbatim from desktop agent.ts. */
export function renderSchema(schema: ToolSchema): string {
  const params = Object.entries(schema.parameters.properties)
    .map(([key, spec]) => {
      const optional = schema.parameters.required.includes(key) ? '' : '?'
      const choices = spec.enum ? ` (${spec.enum.join('|')})` : ''
      return `${key}${optional}: ${spec.type}${choices}`
    })
    .join(', ')
  return `- ${schema.name}(${params}) — ${schema.description}`
}

/**
 * The system prompt for the web agent. Same convention as the desktop assistant
 * prompt: reply with ONLY a raw JSON tool call, receive a "TOOL RESULT" line back,
 * chain as many calls as the task needs, and answer in plain language when done.
 * NO keyword hints or canned mappings — the model reasons from the schemas alone
 * (this is the whole point of replacing the regex intent-parser).
 */
export function buildAgentSystemPrompt(): string {
  return `You are OpenUI, an AI assistant that gets real work done for the user through tools. You are running in the browser product, whose tool surface is documents, spreadsheets, PDFs, slide decks, academic-paper search/download, and GitHub.

To use a tool, respond with ONLY a raw JSON object — no prose before or after it, and NO markdown code fences:
{"tool": "tool_name", "args": {"key": "value"}}

The very first character of a tool-call message MUST be "{". Do not say things like "Sure!" before the JSON. After each tool runs you (and ONLY you) will receive a message starting with "TOOL RESULT" describing what actually happened — use it to decide the next step. Chain as many tool calls as the task needs (one per message). When the task is complete, reply to the user in plain natural language (never wrap your final answer in JSON).

Rules that are the difference between working and broken:
- To actually DO something (write a file, search papers, touch GitHub) you MUST emit the tool-call JSON. Describing the action in words does NOT perform it.
- NEVER write a line starting with "TOOL RESULT" yourself — that text only ever comes from the system after a real tool runs.
- NEVER invent results you have not received (do not claim a file was written or a repo created before the TOOL RESULT confirms it).
- Reason about which tool fits the request from the schemas below; there is no fixed keyword mapping. A "tracker", "sheet of numbers", "budget", or "table" is a spreadsheet; a "write-up", "memo", or "letter" is a document; "slides" or a "deck" is a presentation.
- If the user is just asking a question (no action needed), answer in plain language — do not force a tool call.

Available tools:
${WEB_TOOL_SCHEMAS.map(renderSchema).join('\n')}`
}

/** The nudge sent back when the model emits JSON that is not a valid tool call. */
export const MALFORMED_TOOL_CALL_NUDGE =
  'That was a JSON object but not a tool call — it had no "tool" field, so nothing happened. ' +
  'Either emit a real tool call as {"tool":"…","args":{…}} using one of the available tools, ' +
  'or, if no tool is needed, reply to the user in plain natural language (not JSON).'
