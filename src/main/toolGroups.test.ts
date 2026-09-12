/**
 * toolGroups.test.ts — the per-turn tool-surface selection.
 *
 * The load-bearing test in this file is "every registered tool belongs to
 * exactly one group". toolGroups.ts keeps its tool names as DATA rather than
 * importing the schema arrays (that would be an import cycle), and the price of
 * that choice is drift: add a tool to tools.ts, forget to group it, and it
 * silently disappears from every system prompt — an invisible capability
 * regression. This file is what makes that a red CI run instead.
 *
 * The rest of the file pins the classifier against the cases that actually
 * matter: the 44-case eval set from the fine-tune phase, plus the routing
 * failures observed driving the real app ("check my latest email" →
 * read_clipboard, "draft an email" → hunting for outlook.exe).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { homedir } from 'node:os'

/**
 * Run a case with the coding surface switched ON.
 *
 * github / figma / python are off by default (see capabilities.ts), so the cases
 * below that assert on them are asserting what happens WHEN THE SURFACE IS
 * ENABLED — still true, still worth keeping, and the thing that would silently
 * rot if they were deleted instead. The default-off behaviour has its own block
 * at the end of this file.
 */
const withCoding = <T>(fn: () => T): T => {
  const prev = process.env.OPENUI_ENABLE_CODING
  process.env.OPENUI_ENABLE_CODING = '1'
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env.OPENUI_ENABLE_CODING
    else process.env.OPENUI_ENABLE_CODING = prev
  }
}

afterEach(() => {
  delete process.env.OPENUI_ENABLE_CODING
})

vi.mock('electron', () => ({
  app: { getPath: () => homedir(), getName: () => 'OpenUI' },
  desktopCapturer: {},
  clipboard: {},
  shell: { openPath: vi.fn(async () => ''), trashItem: vi.fn(async () => undefined) },
  systemPreferences: {
    getMediaAccessStatus: () => 'granted',
    isTrustedAccessibilityClient: () => true
  },
  dialog: {},
  BrowserWindow: class {}
}))
vi.mock('./telemetry/posthog', () => ({ trackEvent: () => {} }))

import {
  ALL_GROUPS,
  GROUP_TOOLS,
  GROUP_SUMMARY,
  FALLBACK_GROUPS,
  selectToolGroups,
  groupsForTool,
  toolNamesForGroups,
  renderGroupIndex,
  type ToolGroup
} from './toolGroups'
import { toolSchemas } from './tools'

describe('group data integrity', () => {
  // THE drift guard. If this fails, a tool was added to the registry without
  // being assigned a group, and it is missing from every prompt at runtime.
  it('covers every registered tool', () => {
    const registered = toolSchemas.map((s) => s.name).sort()
    const grouped = toolNamesForGroups(ALL_GROUPS)
    const ungrouped = registered.filter((n) => !grouped.has(n))
    expect(ungrouped, `ungrouped tools — add them to GROUP_TOOLS: ${ungrouped.join(', ')}`).toEqual(
      []
    )
  })

  // The mirror of the above: a group naming a tool that no longer exists means
  // the prompt promises a capability the executor will reject as "Unknown tool".
  it('names no tool that is not registered', () => {
    const registered = new Set(toolSchemas.map((s) => s.name))
    const phantom = [...toolNamesForGroups(ALL_GROUPS)].filter((n) => !registered.has(n)).sort()
    expect(phantom, `grouped but unregistered: ${phantom.join(', ')}`).toEqual([])
  })

  it('gives every group a human summary for the capability index', () => {
    for (const g of ALL_GROUPS) {
      expect(GROUP_SUMMARY[g], `missing GROUP_SUMMARY for ${g}`).toBeTruthy()
    }
  })

  // core is paid for on every turn, so its size is a budget, not a detail.
  it('keeps the always-on core small', () => {
    expect(GROUP_TOOLS.core.length).toBeLessThanOrEqual(18)
  })

  it('is a real shrink — no single group approaches the full registry', () => {
    for (const g of ALL_GROUPS) {
      expect(GROUP_TOOLS[g].length).toBeLessThan(toolSchemas.length / 2)
    }
  })
})

describe('selectToolGroups — always safe', () => {
  it('always includes core', () => {
    for (const text of ['', 'hello', 'send an email', 'make a deck', 'zip my photos']) {
      expect(selectToolGroups(text).has('core')).toBe(true)
    }
  })

  it('widens to the fallback set when nothing matches', () => {
    // A pure knowledge question names no surface at all.
    const groups = selectToolGroups('what is the difference between a LoRA and a full fine-tune?')
    expect([...groups].sort()).toEqual([...FALLBACK_GROUPS].sort())
  })

  it('widens on empty input rather than shipping core alone', () => {
    expect([...selectToolGroups('')].sort()).toEqual([...FALLBACK_GROUPS].sort())
    expect([...selectToolGroups('   ')].sort()).toEqual([...FALLBACK_GROUPS].sort())
  })
})

/**
 * The eval set is the contract: for each case, the tool the model is EXPECTED to
 * pick must be present in the trimmed surface. If it isn't, the shrink caused
 * the miss and no amount of model quality can recover it.
 */
describe('selectToolGroups — the expected tool is always in the loaded surface', () => {
  const cases: Array<{ prompt: string; expected: string }> = [
    // gmail
    { prompt: "draft an email to priya@example.com about tomorrow's demo", expected: 'create_email_draft' },
    { prompt: 'check my latest email', expected: 'find_email_thread' },
    { prompt: "send an email to my manager saying I'll be out sick today", expected: 'send_email' },
    { prompt: 'find the email thread about the invoice from last week', expected: 'find_email_thread' },
    { prompt: 'write a refund email for order 4471 that arrived broken', expected: 'draft_refund_email' },
    { prompt: 'open my email', expected: 'open_app' },
    // calendar
    { prompt: 'schedule a meeting tomorrow at 3pm called Design Review', expected: 'control_calendar' },
    { prompt: "what's on my calendar today?", expected: 'control_calendar' },
    { prompt: 'cancel my 2pm standup on Friday', expected: 'control_calendar' },
    { prompt: 'block out 9 to 11 on Monday for focus time', expected: 'control_calendar' },
    { prompt: 'move my dentist appointment to next Wednesday', expected: 'control_calendar' },
    // github
    { prompt: 'list the open pull requests on my repo', expected: 'list_open_prs' },
    { prompt: 'show me the diff for PR 42', expected: 'get_pr_diff' },
    { prompt: 'open a pull request from my current branch', expected: 'open_pull_request' },
    { prompt: 'does the repo openui-web exist on github?', expected: 'check_repo_exists' },
    { prompt: 'leave a comment on PR 12 saying looks good to me', expected: 'post_pr_comment' },
    // os / files
    { prompt: 'open my Downloads folder', expected: 'open_app' },
    { prompt: "list what's in my Documents folder", expected: 'list_directory' },
    { prompt: 'make a folder called invoices in my Documents', expected: 'create_folder' },
    { prompt: 'find a file named budget on my computer', expected: 'search_files' },
    { prompt: 'read the contents of README.md in my Downloads/Openui-main folder', expected: 'read_file' },
    { prompt: 'open the Openui-main folder in VS Code', expected: 'open_folder_in_editor' },
    { prompt: 'open Spotify', expected: 'open_app' },
    // whatsapp
    { prompt: "message Ashu on WhatsApp that I'll be 10 minutes late", expected: 'send_whatsapp_message' },
    { prompt: 'open my WhatsApp chat with Mom', expected: 'open_whatsapp_chat' },
    // browser / research
    { prompt: 'look up the current price of the RTX 4060 online', expected: 'research_web' },
    { prompt: 'go to github.com in my browser', expected: 'browser_navigate' },
    // overleaf — the tools are useless unless the group actually loads for the
    // phrasings a user would really type.
    { prompt: 'add an introduction section to my Overleaf project', expected: 'overleaf_write_latex' },
    {
      prompt: 'write this up in https://www.overleaf.com/project/65a1b2c3d4e5f60718293a4b',
      expected: 'overleaf_open_project'
    },
    // ...while a plain LaTeX request with no Overleaf project stays on the local
    // authoring tool, which needs no browser and no account.
    { prompt: 'write me a research paper in LaTeX about solar cells', expected: 'write_latex' },
    // unified inbox — these name NO channel, so nothing else in the trigger
    // table can fire for them. Without the inbox trigger they fall through to
    // FALLBACK_GROUPS and summarize_inbox is simply not in the prompt, which
    // looks exactly like the model refusing a feature that shipped.
    { prompt: "what's my summary", expected: 'summarize_inbox' },
    { prompt: 'is there anything from him?', expected: 'summarize_inbox' },
    { prompt: 'catch me up', expected: 'summarize_inbox' },
    { prompt: 'any messages from Ashu today?', expected: 'summarize_inbox' },
    { prompt: 'summarise everything across my channels', expected: 'summarize_inbox' },
    // broadcast — the outbound half. None of these name a channel, so without
    // the inbox trigger covering them the turn falls back to core+email+calendar
    // and broadcast_message is simply absent from the prompt.
    { prompt: "tell everyone I'm running late", expected: 'broadcast_message' },
    { prompt: 'send this to Ashu everywhere', expected: 'broadcast_message' },
    { prompt: 'broadcast the release note to the team', expected: 'broadcast_message' },
    { prompt: 'let everybody know the deploy is done', expected: 'broadcast_message' },
    { prompt: 'post this on every platform', expected: 'broadcast_message' },
    { prompt: 'notify the team about the outage', expected: 'broadcast_message' },
    { prompt: 'the telegram chat 123456789 is Ashu', expected: 'link_contact' },
    { prompt: 'who are my contacts?', expected: 'list_contacts' },
    { prompt: 'mail that summary to Priya', expected: 'send_summary_email' }
  ]

  // Wrapped in withCoding so the github rows still assert something real: this
  // block is about the ROUTING being right for a phrasing, which stays worth
  // proving for a surface that is switched off rather than removed. That the
  // coding groups do not load by default is asserted separately below.
  for (const { prompt, expected } of cases) {
    it(`${JSON.stringify(prompt.slice(0, 52))} keeps ${expected}`, () => {
      withCoding(() => {
        const loaded = toolNamesForGroups(selectToolGroups(prompt))
        expect(loaded.has(expected)).toBe(true)
      })
    })
  }
})

describe('selectToolGroups — picks the right surface', () => {
  it.each([
    ['send an email to jane about the report', 'email'],
    ['what is on my calendar today', 'calendar'],
    ['message Ashu on WhatsApp', 'whatsapp'],
    ['send a telegram to the group', 'telegram'],
    ['post this in slack', 'slack'],
    ['list the open pull requests', 'github'],
    ['review my figma file', 'figma'],
    ['make me a powerpoint deck about Q3', 'slides'],
    ['read the budget spreadsheet', 'spreadsheet'],
    ['resize these photos', 'media'],
    ['zip up my invoices folder', 'archive'],
    ['cancel my Netflix subscription', 'subscriptions'],
    ['run a python script to plot this', 'python'],
    ['turn this docx into a pdf', 'docs']
  ] as Array<[string, ToolGroup]>)('%s → %s', (text, group) => {
    // withCoding for the same reason as the block above: routing correctness is
    // worth keeping for a surface that is off rather than gone.
    withCoding(() => {
      expect(selectToolGroups(text).has(group)).toBe(true)
    })
  })

  // The domain half of an email address is not a website. Before normalizing it
  // away this one false positive pulled in the whole 18-tool browser group and
  // doubled num_ctx for the most common request the app gets.
  it('does not read an email address as a web page', () => {
    const groups = selectToolGroups('draft an email to priya@example.com about the demo')
    expect(groups.has('email')).toBe(true)
    expect(groups.has('browser')).toBe(false)
  })

  it('still reads a real domain as a web page', () => {
    expect(selectToolGroups('go to github.com in my browser').has('browser')).toBe(true)
    expect(selectToolGroups('open example.org and read the pricing').has('browser')).toBe(true)
  })

  it('loads several surfaces for a request that spans them', () => {
    const groups = selectToolGroups('read the sales spreadsheet and email the summary to jane')
    expect(groups.has('spreadsheet')).toBe(true)
    expect(groups.has('email')).toBe(true)
  })

  // The whole point: a focused request must not drag in the entire registry.
  it('trims hard on a focused request', () => {
    const loaded = toolNamesForGroups(selectToolGroups('draft an email to priya about the demo'))
    expect(loaded.size).toBeLessThan(toolSchemas.length / 2)
  })
})

describe('groupsForTool', () => {
  it('maps a tool back to its group', () => {
    expect(groupsForTool('send_email')).toContain('email')
    expect(groupsForTool('control_calendar')).toContain('calendar')
  })

  it('reports overlap honestly', () => {
    // research_web genuinely serves both surfaces.
    expect(groupsForTool('research_web').sort()).toEqual(['browser', 'research'])
  })

  it('returns nothing for an unknown name', () => {
    expect(groupsForTool('no_such_tool')).toEqual([])
  })
})

describe('renderGroupIndex — capability honesty', () => {
  it('names the omitted groups so the assistant does not understate itself', () => {
    const index = renderGroupIndex(new Set<ToolGroup>(['core', 'email']))
    expect(index).toContain('slides')
    expect(index).toMatch(/genuinely CAN/i)
    // Must not advertise what IS loaded as missing.
    expect(index).not.toMatch(/\bemail \(/)
  })

  // The index exists so the assistant does not understate itself. The mirror of
  // that is that it must not OVERstate: naming a capability the app will then
  // refuse is worse than never mentioning it, because the user goes and asks for
  // the thing they were just told about.
  it('does not advertise a surface that is switched off', () => {
    const index = renderGroupIndex(new Set<ToolGroup>(['core', 'email']))
    expect(index).not.toContain('github')
    expect(index).not.toContain('figma')
    expect(index).not.toContain('python')
  })

  it('advertises it again once the surface is enabled', () => {
    withCoding(() => {
      expect(renderGroupIndex(new Set<ToolGroup>(['core', 'email']))).toContain('github')
    })
  })

  it('is empty when nothing was trimmed', () => {
    withCoding(() => {
      expect(renderGroupIndex(new Set(ALL_GROUPS))).toBe('')
    })
  })
})

// ── the coding surface is off by default ──────────────────────────────────────
//
// Purely a product decision: OpenUI is a texting agent, not a build tool. It is
// NOT a prompt-size win — per-turn grouping already kept these schemas out of a
// messaging turn, so the measured saving on messaging requests is zero. See the
// numbers in capabilities.ts.
describe('the coding surface is off by default', () => {
  const codingGroups: ToolGroup[] = ['github', 'figma', 'python']

  it('is not selectable, however plainly the user asks for it', () => {
    for (const text of [
      'list the open pull requests on my repo',
      'review my figma file',
      'run a python script to plot this',
      'build me a react app with a login page'
    ]) {
      const groups = selectToolGroups(text)
      for (const g of codingGroups) expect(groups.has(g), `${text} → ${g}`).toBe(false)
    }
  })

  it('loads none of its tool schemas', () => {
    const names = toolNamesForGroups(selectToolGroups('open a pull request from my branch'))
    for (const n of ['open_pull_request', 'list_open_prs', 'run_python', 'design_preview']) {
      expect(names.has(n), n).toBe(false)
    }
  })

  it('leaves the messaging surface completely intact', () => {
    // The whole point of the cut. If this ever fails, the flag has taken
    // something with it that the product actually sells.
    const cases: Array<[string, ToolGroup]> = [
      ['summarise my inbox', 'inbox'],
      ['send a whatsapp to Ashu', 'whatsapp'],
      ['message the team on slack', 'slack'],
      ['send a telegram to mum', 'telegram'],
      ['draft an email to priya@example.com', 'email'],
      ['what is on my calendar tomorrow', 'calendar']
    ]
    for (const [text, group] of cases) {
      expect(selectToolGroups(text).has(group), `${text} → ${group}`).toBe(true)
    }
  })

  it('actually removes the schemas rather than only hiding the group name', () => {
    // A gate that dropped the group from the index but still loaded its schemas
    // would pass every test above and change nothing about what the model sees.
    // Measured on a coding request, which is where the difference exists at all.
    const ask = 'open a pull request and then tell the team on slack'
    const off = toolNamesForGroups(selectToolGroups(ask)).size
    const on = withCoding(() => toolNamesForGroups(selectToolGroups(ask)).size)
    expect(off).toBeLessThan(on)
  })

  it('does not change the surface of a messaging turn at all', () => {
    // The honest scope of this cut: per-turn grouping already excluded the
    // coding groups from messaging turns, so there is no saving here. Asserted
    // so nobody later claims one — and so a future change that DOES start
    // touching messaging prompts shows up as a failure here.
    for (const ask of ['summarise my inbox', 'send a whatsapp to Ashu', 'message the team on slack']) {
      const off = toolNamesForGroups(selectToolGroups(ask)).size
      const on = withCoding(() => toolNamesForGroups(selectToolGroups(ask)).size)
      expect(off, ask).toBe(on)
    }
  })

  it('comes back in full when enabled, so nothing is lost', () => {
    withCoding(() => {
      expect(selectToolGroups('list the open pull requests on my repo').has('github')).toBe(true)
      expect(selectToolGroups('review my figma file').has('figma')).toBe(true)
      expect(selectToolGroups('run a python script to plot this').has('python')).toBe(true)
    })
  })
})
