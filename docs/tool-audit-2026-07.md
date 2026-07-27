# OpenUI Tool Audit — full automation surface verification

**Date:** 2026-07-27
**Branch:** `run-console-redesign-pr`
**Scope:** Every registered tool, checked against the two failure shapes from the prior fix pass —
(1) wrong-tool routing and (2) silent structural failures (tier gate / permission / unanswered HITL).
**Baseline at start:** `npx vitest run` → 76 files, 1322 passed, 1 skipped.
**After this pass:** **78 files, 1351 passed (+29), 1 skipped, 0 failures** · `tsc --noEmit` clean · eslint clean.

> **Update (verification pass executed).** The bucket-A / bucket-B / CDP gaps flagged below were closed:
> a real filesystem round-trip suite was written and run, `run_python`'s executor path was tested end-to-end
> with a live interpreter, `type_text` got fail-closed logic tests, the `read_file` routing nit was fixed, and
> the browser CDP plumbing was verified live. **One real bug was found and fixed in the process** — see §7.

This is a verification pass, not a rewrite. Where a status is **PASS** it is because a real test was
*executed and observed to pass*, or a real run was performed — never because "the code looks right".

---

## 0. How the inventory was generated

- Enumerated `registry` in `src/main/tools.ts` (lines 6599–6674) plus every `...Registry` spread into it.
- Read `STATE_CHANGING_TOOLS` / `DESTRUCTIVE_TOOLS` (tools.ts 204–413) and `TIER_TOOL_REQUIREMENTS` (tools.ts 434–441) directly.
- Coding tools (`executeCodingTool` in `src/main/codingTools.ts`) are a **separate tool surface** used by
  coding sub-agents (agent.ts / autonomous.ts / codingSubagents.ts). They are **not** spread into the main
  `registry`, so they never reach `executeTool`, the tier gate, or the HITL gate. Listed separately in §B6.

**Counts:** 133 tools in the main `executeTool` registry + 17 in the coding-agent surface = **150 total**.

---

## 1. Tier / permission / HITL gates (the failure-shape #2 surfaces)

| Gate | Where enforced | Reaches the user as visible text? | Verdict |
|---|---|---|---|
| **Tier gate** | `executeTool` returns `{ok:false, tierRequired}` (tools.ts 6724–6734) | `agent.ts` remembers it and, if the turn ends without an explanation, appends `⚠️ \`<tool>\` needs a <Tier> subscription…` to the reply **and** emits a chat chunk (agent.ts 1595–1598, 1767–1769). | **PASS** — this is the exact paper-search-bug class; now surfaced. |
| **HITL gate** | `executeTool` returns `{status:'pending_approval'}` for every STATE_CHANGING tool unless `bypassHitl` (tools.ts 6737). Denial → explicit "User denied… Do not retry" tool result (agent.ts 1755–1760). | Yes — modal + explicit result text. | **PASS** — covered by tools.test.ts "returns pending_approval for EVERY state-changing tool". |
| **OS permission** | Executors return `{ok:false, error:'…Accessibility access is required…', permissionDenied}` (tools.ts 1486–1494 etc.); agent emits `openui:permission:denied` modal (agent.ts 1773–1775). | Yes — specific error string **and** modal. | **PASS** |
| **read_screen cloud-vision** | `read_screen` succeeds on free via local OCR; agent proactively emits `tier-upgrade-needed` on free (agent.ts 1779–1785). | Yes — no silent dead-end. | **PASS** |

Only three tools carry a `TIER_TOOL_REQUIREMENTS` entry: **`computer_use`** (pro), **`browser_vision_act`** (pro),
and the internal **`read_screen_cloud_vision`** branch (pro). All three surface cleanly. No other tool can
silently tier-gate.

---

## 2. Routing audit (failure-shape #1) — description disambiguation

The predecessor already hardened the two known clusters, and the fixes are in place and test-locked:

- **`send_whatsapp_message` vs `open_whatsapp_chat`** — locked by tools.test.ts "description steers a
  message-bearing request here, never open_whatsapp_chat + typing". ✅
- **`search_papers` / `research_papers` vs `research_web` / `computer_use` / browser** — descriptions now say
  *"FIRST and ONLY tool"* and *"never open a browser… to hunt for papers"*. ✅
- **`send_email` vs `create_email_draft`** — cross-reference each other explicitly. ✅

### One new routing gap found (same shape, low severity)

**`read_file` vs `read_pdf` vs `read_spreadsheet`.** `read_pdf` and `read_spreadsheet` each steer away from
`computer_use`, but `read_file` (tools.ts 6483–6494) advertises *"source code, config, notes, CSV/JSON and
other text documents"* and says nothing about binary docs. On "read `report.pdf`" or "open `budget.xlsx`",
`read_file` can plausibly fire and will fail/garble on a binary file, while `read_pdf` / `read_spreadsheet`
are correct. **FIXED this pass** ([tools.ts:6483](src/main/tools.ts:6483)): `read_file` now states it is
*TEXT-ONLY* and names `read_pdf` (PDFs) and `read_spreadsheet` (.xlsx/.csv) as the right tools. Locked by a
routing assertion in tools.test.ts ("read cluster — read_file steers binary docs elsewhere").

> **Note on the model-driven routing table (Step 3.1, 10–20 prompts × free/pro tiers):** that requires a live
> LLM routing run and is **NEEDS-MANUAL-QA** — it cannot be executed deterministically in CI. The static
> description audit above is the actionable, checkable part; the live prompt matrix is in §5.

---

## 3. Inventory + status — main `executeTool` registry (133 tools)

Legend: **SC** = in STATE_CHANGING_TOOLS · **DES** = in DESTRUCTIVE_TOOLS · **Tier** = TIER_TOOL_REQUIREMENTS ·
**Perm/Acct** = OS permission or external account · **Test** = real executor test? (R=round-trip w/ side-effect
assert, L=logic/gate only, S=schema/classification only, ✗=none)

### A. Deterministic, headless, CI-testable

| Tool | File | SC | DES | Perm/Acct | Test | Status |
|---|---|---|---|---|---|---|
| read_spreadsheet | spreadsheet.ts | | | | R (write→read, content asserted) | **PASS** |
| write_spreadsheet | spreadsheet.ts | ✓ | | | R | **PASS** |
| update_cells | spreadsheet.ts | ✓ | | | R | **PASS** |
| add_formula | spreadsheet.ts | ✓ | | | R | **PASS** |
| list_sheets | spreadsheet.ts | | | | R | **PASS** |
| read_pdf | pdf.ts | | | | R | **PASS** |
| create_pdf | pdf.ts | ✓ | | | R (existsSync, bounds) | **PASS** |
| merge_pdfs | pdf.ts | ✓ | | | R | **PASS** |
| split_pdf | pdf.ts | ✓ | | | R | **PASS** |
| watermark_pdf | pdf.ts | ✓ | | | R | **PASS** |
| export_to_pdf | pdf.ts | ✓ | | | R | **PASS** |
| create_document | worddoc.ts | ✓ | | | R (unzip DOCX XML, assert) | **PASS** |
| add_heading | worddoc.ts | ✓ | | | R | **PASS** |
| add_paragraph | worddoc.ts | ✓ | | | R | **PASS** |
| add_doc_table | worddoc.ts | ✓ | | | R | **PASS** |
| add_image | worddoc.ts | ✓ | | | R | **PASS** |
| add_page_break | worddoc.ts | ✓ | | | R | **PASS** |
| list_document_structure | worddoc.ts | | | | R | **PASS** |
| create_presentation | presentation.ts | ✓ | | | R (unzip PPTX XML) | **PASS** |
| add_slide | presentation.ts | ✓ | | | R | **PASS** |
| add_chart | presentation.ts | ✓ | | | R | **PASS** |
| add_slide_table | presentation.ts | ✓ | | | R | **PASS** |
| set_slide_notes | presentation.ts | ✓ | | | R | **PASS** |
| list_slides | presentation.ts | | | | R | **PASS** |
| mail_merge | mailmerge.ts | ✓ | | | R (template+data → output dir) | **PASS** |
| create_zip | archive.ts | ✓ | | | R (round-trip + path-traversal) | **PASS** |
| extract_zip | archive.ts | ✓ | | | R (+ zip-slip guard asserted) | **PASS** |
| list_zip_contents | archive.ts | | | | R | **PASS** |
| get_image_info | imageEdit.ts | | | | R | **PASS** |
| resize_image | imageEdit.ts | ✓ | | | R (dimensions asserted) | **PASS** |
| crop_image | imageEdit.ts | ✓ | | | R (+ out-of-bounds reject) | **PASS** |
| convert_image | imageEdit.ts | ✓ | | | R | **PASS** |
| watermark_image | imageEdit.ts | ✓ | | | R | **PASS** |
| get_media_info | mediaEdit.ts | | | ffmpeg | R (real ffmpeg round-trip) | **PASS** |
| trim_video | mediaEdit.ts | ✓ | | ffmpeg | R (real clip, size asserted) | **PASS** |
| convert_media | mediaEdit.ts | ✓ | | ffmpeg | R | **PASS** |
| extract_audio | mediaEdit.ts | ✓ | | ffmpeg | R (WAV produced) | **PASS** |
| merge_media | mediaEdit.ts | ✓ | | ffmpeg | R | **PASS** |
| print_file | print.ts | ✓ | | | R (message-path asserted) | **PASS** |
| notify_user | notifications.ts | | | | R (rate-limit/format) | **PASS** |
| search_papers | paperResearch.ts | | | network | L (parse helpers only) | **NEEDS-MANUAL-QA** ¹ |
| download_paper | paperResearch.ts | ✓ | | network | L (parse helpers only) | **NEEDS-MANUAL-QA** ¹ |
| summarize_paper | paperResearch.ts | ✓ | | network+model | L | **NEEDS-MANUAL-QA** ¹ |
| research_papers | paperResearch.ts | ✓ | | network+model | L | **NEEDS-MANUAL-QA** ¹ |
| **read_file** | tools.ts | | | | R (fsTools.test.ts — write→read, empty, dir-reject, not-found) | **PASS** ⁵ |
| **write_file** | tools.ts | ✓ | ✓ | | R (fsTools.test.ts — real bytes, parent-create, home-boundary) | **PASS** ⁵ |
| **create_folder** | tools.ts | ✓ | ✓ | | R (nested create + trust boundary) | **PASS** |
| **move_file** | tools.ts | ✓ | | | R (fsTools.test.ts — src gone/dst present, parent-create) | **PASS** ⁵ |
| **copy_file** | tools.ts | ✓ | | | R (fsTools.test.ts — bytes copied, src kept, folder-reject) | **PASS** ⁵ |
| **delete_file** | tools.ts | ✓ | ✓ | | R (fsTools.test.ts — routes via trashItem, not-found) | **PASS** ⁵ |
| **list_directory** | tools.ts | | | | R (fsTools.test.ts — type tags, empty dir) | **PASS** ⁵ |
| **search_files** | tools.ts | | | | ✗ (shells out to mdfind/ChildItem/find) | **UNTESTED** ² |
| **search_local_files** | tools.ts | | | Ollama+RAG | ✗ | **UNTESTED** ² |
| **read_clipboard** | tools.ts | | | | R (fsTools.test.ts — round-trip + empty) | **PASS** ⁵ |
| **write_clipboard** | tools.ts | ✓ | | | R (fsTools.test.ts — round-trip + empty-reject) | **PASS** ⁵ |
| **run_python** (registry) | tools.ts | ✓ | ✓ | | R (runPythonExecutor.test.ts — real interpreter, stdout, args, non-zero) | **PASS** ⁵ ⁶ |
| **run_workflow** | tools.ts | ✓ | | | ✗ | **UNTESTED** ² |
| write_latex | tools.ts | ✓ | | | L (escapeLatexText tested) | **NEEDS-MANUAL-QA** |
| design_preview | designFlow.ts | ✓ | | | ✗ | **UNTESTED** ² |

¹ `paperResearch.test.ts` thoroughly tests the pure request-builders and response-parsers
(`buildArxivQueryPath`, `parseArxivAtom`, `buildSemanticScholarPath`, `parseSemanticScholarJson`, `mergePapers`)
against fixtures — so the parsing side is **PASS**. What is **not** exercised is a real arXiv / Semantic Scholar
HTTP round-trip (deliberately, to keep CI offline/non-flaky). A live smoke test is in §5.

² **These are the concrete coverage gaps.** The most fundamental filesystem tools in the *main* registry have
no executor-level round-trip test asserting a real side effect. `create_folder` is the lone exception. This is
the single largest bucket-A gap and is the first thing to fill (see §6 plan). *Not necessarily broken — just
unverified.* (Note: the *coding-agent* `read_file`/`write_file`/`apply_patch` in codingTools.ts **are** round-trip
tested — §B6 — but that is a different surface.)

### B. Keyboard / OCR / vision desktop automation

| Tool | File | SC | DES | Tier | Perm | Test | Status |
|---|---|---|---|---|---|---|---|
| open_whatsapp_chat | tools.ts | ✓ | | | Accessibility | L (scoreContactCandidates, resolveWhatsAppContact) | **PASS** (logic) / MANUAL (live) |
| send_whatsapp_message | tools.ts | ✓ | ✓ | | Accessibility | L (scoring + routing-desc + HITL) | **PASS** (logic) / MANUAL (live) |
| create_whatsapp_group | tools.ts | ✓ | ✓ | | Accessibility | L (validateGroupMembers, gates) | **PASS** (logic) / MANUAL (live) |
| leave_whatsapp_group | tools.ts | ✓ | ✓ | | Accessibility | L (gates) | **PASS** (logic) / MANUAL (live) |
| computer_use | tools.ts | ✓ | | pro | Accessibility+ScreenRec | L (per-app consent gate, tier gate, revoke) | **PASS** (gates) / MANUAL (live) |
| read_screen | tools.ts | | | (cloud=pro) | ScreenRecording | L (ocr.test.ts + tier surfacing) | **PASS** (OCR+gate) / MANUAL (cloud) |
| left_click | tools.ts | ✓ | | | Accessibility | L (HITL+perm gate) | **PASS** (gate) / MANUAL (live) |
| right_click | tools.ts | ✓ | | | Accessibility | L (gate) | **PASS** (gate) / MANUAL (live) |
| double_click | tools.ts | ✓ | | | Accessibility | L (gate) | **PASS** (gate) / MANUAL (live) |
| move_mouse | tools.ts | ✓ | | | Accessibility | L (gate) | **PASS** (gate) / MANUAL (live) |
| scroll_screen | tools.ts | ✓ | | | Accessibility | L (gate) | **PASS** (gate) / MANUAL (live) |
| press_keys | tools.ts | ✓ | | | Accessibility | L (parseKeyCombo tested + gate) | **PASS** (logic) / MANUAL (live) |
| type_text | tools.ts | ✓ | | | Accessibility | L (HITL gate + empty/missing-text fail-closed — tools.test.ts) | **PASS** (logic) / MANUAL (live) ³ |

³ **Closed this pass.** `type_text` now has fail-closed logic tests (tools.test.ts): HITL gate, and it rejects
empty/missing text *before* loading nut-js or touching the keyboard. The live keystroke synthesis remains
manual-only (it drives real OS input).

⁵ **Closed this pass** — was UNTESTED, now a real executed round-trip that asserts an actual side effect
(bytes on disk, file moved/gone, clipboard value, Recycle-Bin routing, live interpreter stdout). New files:
`src/main/fsTools.test.ts` (17 tests) and `src/main/runPythonExecutor.test.ts` (7 tests).

⁶ **A real bug was found here** while writing the round-trip — see §7.

### C. External-account tools (live credentials required)

All share the same pattern and the same verdict basis: **token/credential gate returns a specific error when
the credential is missing** (verified by executed tests) and **request-builders / response-parsers are unit
tested without the live account** (verified). The live end-to-end path is **NEEDS-MANUAL-QA** (§5).

| Tool group (file) | Tools | Offline test (executed) | Status |
|---|---|---|---|
| GitHub (github.ts) | list_open_prs, get_pr_diff, post_pr_comment, check_repo_exists, create_repo, update_readme, push_files, open_pull_request, merge_pr | token gate + arg validation, per-tool | **PASS** (offline) / **NEEDS-MANUAL-QA** (live) |
| Gmail (gmail.ts) | send_email, create_email_draft, find_email_thread | buildAuthUrl/scopes, token-exchange/refresh bodies, buildMimeMessage, normalizeRecipients, deriveSubject | **PASS** (offline) / **NEEDS-MANUAL-QA** (live) |
| Telegram (telegram.ts) | send_telegram_message, read_telegram_messages, list_telegram_chats | isValidBotToken (+path-injection), isValidChatId, extractMessage, formatChats/Messages, token gate | **PASS** (offline) / **NEEDS-MANUAL-QA** (live) |
| Google Calendar (googleCalendar.ts) | control_calendar | buildAuthUrl/scopes, token bodies, buildEventResource, normalizeAttendees | **PASS** (offline) / **NEEDS-MANUAL-QA** (live) |
| Google Drive (googleDrive.ts) | upload_to_drive, download_from_drive, list_drive_files, share_drive_file | request-building + not-connected gate | **PASS** (offline) / **NEEDS-MANUAL-QA** (live) |
| Slack (slack.ts) | send_slack_message, list_slack_channels, read_slack_channel, search_slack | looksLikeChannelId, normalizeChannelName, explainSlackError, not-connected gate | **PASS** (offline) / **NEEDS-MANUAL-QA** (live) |
| Figma read (figma.ts) | get_figma_file, get_figma_node_details, get_figma_components, get_figma_design_system, export_figma_tokens, export_figma_frames, figma_frame_to_code, list_figma_comments, create_figma_comment | 122 assertions — token gate + response parsing | **PASS** (offline) / **NEEDS-MANUAL-QA** (live) |
| Figma build (figmaBuild.ts) | setup_figma_builder, build_figma_design, figma_builder_status | 71 assertions — open-before-queue ordering, queue cap, plugin-reconnect, file-key guard | **PASS** (logic) / **NEEDS-MANUAL-QA** (live plugin) |

`control_calendar` is listed under both A (routing) and C (it needs Google auth). `send_email` /
`create_email_draft` / `find_email_thread` are the Gmail row.

### D. Browser control (CDP-driven)

| Tool | File | SC | Test | Status |
|---|---|---|---|---|
| connect_browser | tools.ts | ✓ | L (HITL gate) | **PASS** (gate) / MANUAL |
| browser_navigate, browser_click, browser_fill_input, browser_upload_file, browser_open_tab, browser_switch_tab, browser_close_tab, browser_scroll, browser_history, browser_press_key | tools.ts | ✓ | L (gate) + plumbing verified live ⁴ | **PASS** (plumbing) / **NEEDS-MANUAL-QA** (live app) ⁴ |
| browser_extract_text, browser_list_tabs, browser_read_elements, browser_screenshot, browser_wait_for | tools.ts | | L (gate) + plumbing verified live ⁴ | **PASS** (plumbing) / **NEEDS-MANUAL-QA** (live app) ⁴ |
| browser_vision_act | tools.ts | ✓ | pro | L (tier gate first) | **PASS** (gate) / MANUAL |
| research_web | tools.ts | ✓ | L (parseDuckDuckGoResults tested) | **PASS** (parsing) / MANUAL (live) |
| research_audit | tools.ts | ✓ | L (slugifyForPath, researchKeywords, pickKeySentences) | **PASS** (helpers) / MANUAL (live) |
| Browser consent + sanitizer | browser/consent.ts, browser/sanitizer.ts | | R (consent.test.ts, sanitizer.test.ts) | **PASS** |

⁴ The per-site **consent** logic and the result **sanitizer** are well tested, and the "won't run without a
connected session" gate is tested. **Verified live this pass:** I drove the exact Playwright API the tools use
(persistent context → `page.goto` → `page.title()` → `body.innerText` → `page.click`) against a local HTTP
page and observed a real round-trip — title read back, body text extracted, and a click that mutated the DOM
(`clicked!`). So the CDP plumbing **does automate**. It is deliberately **not** committed as a CI test:
`browser_navigate` only accepts `http(s)://` (rejects `file://`), so a faithful executor-level test needs a
local HTTP server + forced-isolated profile + seeded consent state — a genuinely flaky combination. Kept as
**NEEDS-MANUAL-QA** (§5 #19), now with the plumbing empirically confirmed working.

### B6. Coding-agent tool surface (separate — `executeCodingTool`, not in main registry)

| Tools | File | Test | Status |
|---|---|---|---|
| write_file, read_file, edit_file, apply_patch, search_code, find_definition, find_usages, git, list_files, search_codebase_semantic, open_in_browser, run_tests, install_dependencies, run_script, run_pytest, run_python, run_cpp | codingTools.ts | R (codingTools.test.ts, 33 executor calls / 39 asserts) | **PASS** for the round-tripped ones; remainder **UNTESTED** |

These bypass `executeTool`'s tier/HITL gates entirely; mutation control is via `mutatesWorkspace()` in the
sub-agent loop, not STATE_CHANGING_TOOLS. Out of scope for the failure-shape audit (no tier gate applies), but
inventoried for completeness.

---

## 4. Summary of findings

**The gate machinery is sound (shape #2).** The tier gate, HITL gate, and OS-permission gate all surface
specific, user-visible text — verified by executed tests. The two originally-reported bugs (paper-search tier
gate, WhatsApp HITL occlusion) are fixed and test-locked.

**One NEW bug of shape #2 found & fixed:** `run_python` silently rejected every call carrying CLI `args`
(schema declared `object`, executor + validator expect an array). Found by an executed test, not a code read.
Fixed and locked — full write-up in §7.

**One routing nit (shape #1, low severity) fixed:** `read_file` now steers PDF/spreadsheet reads to
`read_pdf` / `read_spreadsheet` (description + routing assertion).

**Coverage gaps closed this pass (were the bucket-A/B/CDP gaps):**
1. ✅ Main-registry filesystem tools — `read_file`, `write_file`, `move_file`, `copy_file`, `delete_file`,
   `list_directory`, `read_clipboard`, `write_clipboard` now have executed round-trip tests asserting real
   side effects. (`search_files` still ✗ — it shells out to OS search; see remaining list.)
2. ✅ `run_python` executor — real interpreter round-trip (stdout, args, non-zero exit).
3. ✅ `type_text` — fail-closed logic tests.
4. ✅ `browser_*` CDP plumbing — verified live (navigate/extract/click round-trip observed).

**Remaining gaps (lower priority, not regressions):**
- `search_files`, `search_local_files` (RAG/Ollama), `run_workflow`, `design_preview`, `write_latex` — executors
  still untested. `search_files` and `search_local_files` depend on external state (OS index / Ollama).
- `paperResearch` live HTTP round-trip — intentionally un-run in CI (parsing is covered).

**Nothing here is marked PASS on inspection alone.** Every PASS corresponds to a test executed and observed
green in this pass (or, for bucket B/C/D "live" paths, explicitly downgraded to NEEDS-MANUAL-QA).

---

## 5. Manual QA checklist (category C / D — needs your real accounts / live OS)

Run each in OpenUI. "Silent-fail signal" = what tells you the failure never reached the UI as text.

### WhatsApp Desktop (needs WhatsApp signed in)
1. Type: **"Send a WhatsApp message to <a real contact> saying 'audit ping'."**
   Expect: HITL modal previewing exact contact + text → after Allow, message appears in that chat.
   Silent-fail: turn ends with no modal, or "done" with nothing sent (the occlusion bug — should now raise the window first).
2. Type: **"Open my WhatsApp chat with <contact>"** (no message).
   Expect: chat opens, **no** message sent. Silent-fail: it types anything into the box.
3. Type: **"Create a WhatsApp group 'Audit' with <two contacts>"** → expect member-preview modal; Allow → group exists.

### Gmail (needs Google connected)
4. **"Draft an email to me@x.com, subject Audit, body 'draft test'."**
   Expect: **no** confirmation modal (drafts don't send); draft visible in Gmail. Silent-fail: "sent" wording, or nothing in Drafts.
5. **"Send an email to me@x.com saying 'send test'."** Expect: confirm modal → after Allow, arrives in inbox.
6. Disconnect Google, retry #5. Expect: clear "not connected / connect Gmail first" text — **not** a generic failure.

### Telegram (needs bot token + a chat)
7. **"Send a Telegram message to <chat> 'tg audit'."** Expect: confirm modal → delivered.
8. Clear `TELEGRAM_BOT_TOKEN`, retry. Expect: specific "no bot token" message.

### Slack (needs Slack connected)
9. **"Post 'slack audit' to #<channel>."** Expect: confirm modal → message in channel.
10. **"List my Slack channels."** Expect: channel list (read-only, no modal). Silent-fail: empty with no "not connected" note.

### Google Calendar / Drive
11. **"Add a calendar event 'Audit sync' tomorrow 3pm."** Expect: confirm → event created.
12. **"Upload <file> to my Drive."** Expect: confirm → file in Drive, link returned.
13. **"Share <drive file> with someone@x.com."** Expect: confirm modal (destructive) → they get access.

### GitHub (needs GITHUB_TOKEN)
14. **"Check if github.com/<you>/<repo> exists."** (read-only) → yes/no, no modal.
15. **"Open a pull request in <you>/<repo> from branch X."** Expect: confirm modal (destructive) → PR URL.
16. Unset `GITHUB_TOKEN`, retry #15 → specific "GitHub token required" text.

### Figma (needs FIGMA token / desktop app + plugin)
17. **"Get the Figma file <key> structure."** → node tree returned; bad token → specific auth error.
18. **"Build <simple spec> in Figma."** Expect: Figma comes to front; if plugin not running, a clear
    "plugin isn't running / open it" message — **not** a hang. (figmaBuild's queue holds the job for reconnect.)

### Browser control (CDP) + computer_use (Pro)
19. **"Connect my browser, go to example.com, and extract the page text."** Expect: connect modal → text returned.
20. On a **free** account: **"Use computer control to open Notepad and type hello."**
    Expect: visible **"computer_use needs a Pro subscription"** message (the tier-gate surfacing). Silent-fail:
    turn just stops with nothing said.
21. Revoke Accessibility permission, then **"click at 100,100."** Expect: specific "Accessibility access is
    required… System Settings → Privacy & Security" error + modal.

### Paper research (network, free)
22. **"Find 3 papers about graph neural networks and summarize them."** Expect: real arXiv/Semantic Scholar
    results + a saved research folder. Silent-fail: it opens a browser instead (should not — description forbids it),
    or returns nothing with no error.

---

## 6. Fix plan — EXECUTED

| # | Item | Status |
|---|---|---|
| 1 | `fsTools.test.ts` — round-trip for read/write/move/copy/delete/list_directory/clipboard | ✅ **Done** — 17 tests, all green |
| 2 | `run_python` executor end-to-end (real interpreter) | ✅ **Done** — `runPythonExecutor.test.ts`, 7 tests; **surfaced the §7 bug** |
| 3 | `read_file` description disambiguation vs `read_pdf`/`read_spreadsheet` + routing assertion | ✅ **Done** — tools.ts:6483, tools.test.ts |
| 4 | `type_text` fail-closed logic tests | ✅ **Done** — tools.test.ts |
| 5 | CDP plumbing round-trip | ✅ **Verified live** (not committed as CI test — see ⁴); manual QA §5 #19 |
| 6 | opt-in `search_papers` live smoke behind env flag | ⏭️ **Deferred** — parsing already covered; left as manual to keep CI offline |

Result: **+29 tests, full suite 1351 green, `tsc` clean, eslint clean.** No billing/auth/UI changes; no new tools.
Only source change is the one-line `read_file` description + the §7 schema-type fix.

---

## 7. Bug found & fixed this pass — `run_python` CLI args were silently rejected

**Shape:** #2 (silent structural failure) — a valid call refused before it could run, with no useful signal.

**What:** `run_python`'s `args` parameter was declared `type: 'object'` in its JSON schema
([tools.ts:5607, before](src/main/tools.ts)), but the executor reads it as an **array**
(`Array.isArray(args.args) ? args.args.map(String) : []`, tools.ts:5553). `validateArgs` treats an array as
**not** an object (`… || Array.isArray(val)` → invalid), so **every `run_python` call that passed CLI args**
— e.g. `{ code: "...", args: ["--epochs", "5"] }` — was rejected with `Invalid arguments for "run_python":
"args" must be an object.` before the interpreter ever ran. A script needing arguments could never be run.

**How found:** the new executor round-trip test "forwards CLI args to the script" failed with `ok:false`
instead of running the script — a real observed failure, not a code read.

**Fix:** declare `args` as `type: 'array'` with `items: { type: 'string' }` (matching every other array param,
e.g. `create_whatsapp_group.members`). `validateArgs` has no array branch, so it passes the array through; the
executor's `Array.isArray` guard already handles it. ([tools.ts:5607](src/main/tools.ts:5607))

**Locked by:** a schema-shape assertion (runs without Python) **and** a live-interpreter test asserting
`args: ["--flag","x"]` now reaches execution and `sys.argv[1]` is forwarded (`ARGV alpha`).
