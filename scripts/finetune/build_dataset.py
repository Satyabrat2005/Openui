#!/usr/bin/env python3
"""build_dataset.py — assemble the LoRA training corpus for OpenUI's tool-calling.

Sources, in descending order of trust:

  1. REAL trajectories from the user's own openui.db (trainingStore.ts writes
     them). Successful steps are used as-is. Failed steps are NOT thrown away:
     the recorded failure modes (empty args, POSIX paths on a Windows box) are
     turned into (a) a corrected target for the same instruction, and (b) a
     two-turn error-RECOVERY example where the model sees the real error text
     and emits the fixed call. That is how a failure teaches without training
     the model to reproduce it — the bad call is only ever in the *context*,
     never in the label.

  2. SYNTHETIC examples generated against the REAL tool schemas captured from
     the running app. Flagged source="synthetic" on every row so the split is
     always auditable. A single dev machine does not produce thousands of real
     trajectories; pretending otherwise would be the dishonest part.

Two things this script refuses to do:

  * Contamination. Every candidate is checked against evalset.json (normalised
    text AND near-duplicate token overlap). A training set that contains the
    eval prompts produces a beautiful, meaningless score.

  * Full-prompt training. Each example carries a COMPACT system prompt (the real
    preamble + a sampled subset of the real schemas, always including the target
    tool). The app's real prompt is ~15k tokens; at that length a 7B QLoRA step
    does not fit in 8 GB. This is a deliberate, disclosed approximation — see
    docs for what it costs.
"""

import argparse
import json
import os
import random
import re
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
EVAL = os.path.join(HERE, "eval")
HOME = os.path.expanduser("~")

random.seed(1234)


# ── real tool schemas, captured from the running app ─────────────────────────

# WHERE THE SCHEMAS COME FROM — CHANGED 2026-09-05.
#
# This used to read eval/system_prompt.txt, the single full-surface prompt
# captured 2026-08-11. Since the per-turn tool grouping landed (#161) the app
# never builds that prompt, and the capture predates the whole cross-channel
# surface: summarize_inbox, broadcast_message, send_summary_email, link_contact
# and list_contacts are simply not in it. Generating against it therefore CANNOT
# produce a row for any of them — `add()` silently skips a template whose tool is
# not in SCHEMAS, so the tools the product is built around would have gone on
# getting zero training signal without anything failing.
#
# The union over a directory of per-case captured prompts is the honest input:
# still captured from the running app, never reconstructed, just one file per
# turn instead of one for all of them.

DEFAULT_PROMPT_DIR = os.path.join(EVAL, "captured-prompts-2026-09-05")


def _split_params(sig):
    """Split a rendered parameter list on TOP-LEVEL commas.

    The old parser matched `\\(([^)]*)\\)`, which stops at the first ')' — and
    eight tools render an enum inside their parameter list, e.g.
    `link_contact(name: string, channel: string (whatsapp|telegram|slack|gmail),
    handle: string)`. Everything after the enum was dropped, so a template for
    such a tool would have been generated against a truncated parameter list.
    """
    parts, depth, buf = [], 0, []
    for ch in sig:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append("".join(buf))
            buf = []
            continue
        buf.append(ch)
    parts.append("".join(buf))
    return [p.strip() for p in parts if p.strip()]


def parse_tool_line(line):
    """(name, params) for one rendered `- tool(...)` line, or None."""
    m = re.match(r"^- ([a-z_0-9]+)\(", line)
    if not m:
        return None
    depth = 0
    end = None
    for i in range(m.end() - 1, len(line)):
        if line[i] == "(":
            depth += 1
        elif line[i] == ")":
            depth -= 1
            if depth == 0:
                end = i
                break
    if end is None:
        return None
    params = []
    for p in _split_params(line[m.end():end]):
        key = p.split(":")[0].strip()
        params.append({"name": key.rstrip("?"), "optional": key.endswith("?")})
    return m.group(1), params


def _parts_from_text(sp):
    i = sp.find("Available tools:")
    j = sp.find("Examples — map the request")
    if i == -1 or j == -1 or j < i:
        return None
    return sp[:i].rstrip(), [l for l in sp[i:j].split("\n") if l.startswith("- ")], sp[j:]


def load_prompt_parts(prompt_dir=None):
    """Preamble + schema union + postamble.

    With `prompt_dir`, schemas are the UNION over every captured per-case prompt
    (a tool appears only in the prompts whose turn selected its group), while the
    preamble and postamble — which are group-independent — are taken from the
    single largest capture that contains both markers, so they are one real
    prompt's prose rather than a stitch of several.
    """
    if prompt_dir:
        import glob as _glob
        files = sorted(_glob.glob(os.path.join(prompt_dir, "*.txt")))
        if not files:
            raise SystemExit(f"no captured prompts in {prompt_dir}")
        schemas = {}
        best = None
        for f in files:
            text = open(f, encoding="utf-8").read()
            parts = _parts_from_text(text)
            if parts is None:
                continue  # e.g. the builder-session prompt, which lists no tools
            pre, lines, post = parts
            if best is None or len(text) > best[0]:
                best = (len(text), pre, post)
            for line in lines:
                parsed = parse_tool_line(line)
                if not parsed:
                    continue
                name, params = parsed
                if len(params) >= len(schemas.get(name, {}).get("params", [])):
                    schemas[name] = {"line": line, "params": params}
        if best is None:
            raise SystemExit(f"no capture in {prompt_dir} contains the prompt markers")
        return best[1], schemas, best[2]

    sp = open(os.path.join(EVAL, "system_prompt.txt"), encoding="utf-8").read()
    parts = _parts_from_text(sp)
    if parts is None:
        raise SystemExit("system_prompt.txt does not look like a captured prompt")
    preamble, tool_lines, postamble = parts
    schemas = {}
    for line in tool_lines:
        parsed = parse_tool_line(line)
        if not parsed:
            continue
        name, params = parsed
        schemas[name] = {"line": line, "params": params}
    return preamble, schemas, postamble


# Loaded at import so the templates below can gate on SCHEMAS; main() reloads it
# if --prompt-dir names a different capture. The default is the per-case capture
# directory, falling back to the stale single prompt only if it is missing — and
# saying so, because that fallback silently drops every cross-channel template.
if os.path.isdir(DEFAULT_PROMPT_DIR):
    PROMPT_SOURCE = DEFAULT_PROMPT_DIR
    PREAMBLE, SCHEMAS, POSTAMBLE = load_prompt_parts(DEFAULT_PROMPT_DIR)
else:
    PROMPT_SOURCE = os.path.join(EVAL, "system_prompt.txt")
    print(f"WARNING: {DEFAULT_PROMPT_DIR} missing — falling back to the 2026-08-11 "
          f"full-surface prompt, which predates the cross-channel tools. Every "
          f"summarize_inbox / broadcast_message / contact template will be SKIPPED.",
          file=sys.stderr)
    PREAMBLE, SCHEMAS, POSTAMBLE = load_prompt_parts()

# Condensed protocol rules: the parts of the postamble that actually constrain
# the OUTPUT FORMAT, which is what we are training. Kept short so the compact
# prompt stays inside the sequence budget.
PROTOCOL_TAIL = """
Rules that matter most:
- A tool call is the WHOLE message: the first character is "{" and there is nothing before or after it. No markdown fences.
- Never invent results. Call the tool and wait for the real TOOL RESULT.
- Paths on this machine are Windows paths under """ + HOME + """. Never emit /Users/..., /home/..., ~/ or /workspace.
- If the request needs no tool, answer in plain natural language with no JSON.
"""


def compact_system(target_tool, n_distractors=None):
    """Real preamble + a sampled slice of the real schemas (target always in)."""
    if n_distractors is None:
        n_distractors = N_DISTRACTORS
    names = [t for t in SCHEMAS if t != target_tool]
    picked = random.sample(names, min(n_distractors, len(names)))
    if target_tool:
        picked.append(target_tool)
    random.shuffle(picked)
    lines = "\n".join(SCHEMAS[p]["line"] for p in picked if p in SCHEMAS)
    return f"{PREAMBLE}\n\nAvailable tools:\n{lines}\n{PROTOCOL_TAIL}"


N_DISTRACTORS = 6


def call_json(tool, args):
    return json.dumps({"tool": tool, "args": args}, ensure_ascii=False)


# ── contamination guard ──────────────────────────────────────────────────────

def norm(s):
    return re.sub(r"[^a-z0-9 ]+", " ", (s or "").lower()).strip()


def tokens(s):
    return set(norm(s).split())


class EvalGuard:
    def __init__(self):
        ev = json.load(open(os.path.join(EVAL, "evalset.json"), encoding="utf-8"))
        self.exact = {norm(c["prompt"]) for c in ev["cases"]}
        self.tok = [(c["id"], tokens(c["prompt"])) for c in ev["cases"]]
        self.blocked = []

    def is_contaminated(self, text):
        n = norm(text)
        if n in self.exact:
            self.blocked.append((text, "exact"))
            return True
        t = tokens(text)
        if not t:
            return False
        for cid, et in self.tok:
            if not et:
                continue
            overlap = len(t & et) / len(t | et)       # Jaccard
            if overlap >= 0.75:
                self.blocked.append((text, f"near:{cid}:{overlap:.2f}"))
                return True
        return False


# ── 1. real trajectories ─────────────────────────────────────────────────────

POSIX_RE = re.compile(r"^(/(?:Users|home|tmp|workspace|var|opt|mnt)/|~/|/$)")

WIN_FOLDERS = {
    "desktop": os.path.join(HOME, "Desktop"),
    "documents": os.path.join(HOME, "Documents"),
    "downloads": os.path.join(HOME, "Downloads"),
    "pictures": os.path.join(HOME, "Pictures"),
    "music": os.path.join(HOME, "Music"),
    "videos": os.path.join(HOME, "Videos"),
}


def fix_posix_path(p):
    """Rewrite a hallucinated POSIX path to the real Windows equivalent."""
    if not isinstance(p, str):
        return None
    s = p.strip()
    if not POSIX_RE.match(s):
        return None
    tail = re.sub(r"^(/(?:Users|home)/[^/]+/|~/|/workspace/?|/tmp/?|/)", "", s)
    tail = tail.strip("/")
    if not tail:
        return HOME
    parts = tail.split("/")
    first = parts[0].lower()
    if first in WIN_FOLDERS:
        return os.path.join(WIN_FOLDERS[first], *parts[1:]) if len(parts) > 1 \
            else WIN_FOLDERS[first]
    return os.path.join(HOME, *parts)


def guess_args_from_instruction(tool, instruction):
    """Best-effort correct args for a step the model emitted with args {}.

    Conservative on purpose: if the instruction does not clearly contain the
    argument, we return None and the example is dropped rather than guessed. A
    wrong label is worse than a missing one.
    """
    text = instruction or ""
    low = text.lower()
    if tool in ("list_directory", "create_folder", "read_file", "open_folder_in_editor"):
        for word, path in WIN_FOLDERS.items():
            if word in low:
                m = re.search(r"(?:called|named)\s+([A-Za-z0-9._-]+)", text)
                if tool == "create_folder" and m:
                    return {"path": os.path.join(path, m.group(1))}
                return {"path": path}
        return None
    if tool in ("search_files", "search_local_files", "research_web"):
        m = re.search(r"(?:for|named|called|about)\s+([A-Za-z0-9 ._-]{3,40})", text)
        if m:
            return {"query": m.group(1).strip()}
        return None
    return None


def load_real(db_path, guard, stats):
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    rows = list(con.execute("""
        SELECT e.instruction, e.quality_score, s.tool_name, s.tool_args,
               s.tool_result, s.status
        FROM training_steps s
        JOIN training_examples e ON e.id = s.example_id
        ORDER BY s.example_id, s.step_index
    """))
    out = []
    for r in rows:
        instr = (r["instruction"] or "").strip()
        tool = r["tool_name"]
        if not instr or not tool or tool not in SCHEMAS:
            stats["real_skipped_unknown_tool"] += 1
            continue
        if guard.is_contaminated(instr):
            stats["real_blocked_contamination"] += 1
            continue
        try:
            args = json.loads(r["tool_args"] or "{}")
        except Exception:
            args = {}
        if not isinstance(args, dict):
            args = {}

        sys_p = compact_system(tool)

        if r["status"] == "success":
            out.append({
                "source": "real", "kind": "success", "tool": tool,
                "messages": [
                    {"role": "system", "content": sys_p},
                    {"role": "user", "content": instr},
                    {"role": "assistant", "content": call_json(tool, args)},
                ]})
            stats["real_success"] += 1
            continue

        # ── failures ────────────────────────────────────────────────────────
        fixed = None
        if not args:
            fixed = guess_args_from_instruction(tool, instr)
            kind = "repaired_empty_args"
        else:
            patched = dict(args)
            changed = False
            for k, v in args.items():
                nv = fix_posix_path(v)
                if nv:
                    patched[k] = nv
                    changed = True
            if changed:
                fixed = patched
                kind = "repaired_posix_path"

        if not fixed:
            stats["real_failure_undrepairable"] += 1
            continue

        # (a) corrected single-turn: right answer for the same instruction
        out.append({
            "source": "real", "kind": kind, "tool": tool,
            "messages": [
                {"role": "system", "content": sys_p},
                {"role": "user", "content": instr},
                {"role": "assistant", "content": call_json(tool, fixed)},
            ]})
        stats["real_repaired"] += 1

        # (b) error-recovery: the BAD call appears only as context, never as the
        #     label, followed by the real error text and the corrected call.
        err = (r["tool_result"] or "")[:300]
        out.append({
            "source": "real", "kind": "recovery", "tool": tool,
            "messages": [
                {"role": "system", "content": sys_p},
                {"role": "user", "content": instr},
                {"role": "assistant", "content": call_json(tool, args)},
                {"role": "user", "content": f"TOOL RESULT ({tool}): {err}"},
                {"role": "assistant", "content": call_json(tool, fixed)},
            ]})
        stats["real_recovery"] += 1
    return out


# ── 2. synthetic generation against real schemas ─────────────────────────────

PEOPLE = ["Ashu", "Priya", "Mom", "Dad", "Sam", "Ravi", "Meera", "Arjun", "Neha",
          "Rohit", "Ananya", "Kabir", "Diya", "Vikram", "Tanya", "Imran", "Lakshmi",
          "Farhan", "Sanjay", "Ritu", "Karan", "Pooja", "Dev", "Sneha", "Manav",
          "Aisha", "Nikhil", "Shreya", "Gaurav", "Tara"]
EMAILS = ["jane@acme.com", "raj@corp.io", "team@startup.dev", "hr@company.com",
          "support@vendor.net", "alex@design.studio", "billing@host.cloud",
          "priya@example.org", "dev-team@internal.net", "sales@partner.co",
          "landlord@rentals.in", "admin@school.edu", "bookings@clinic.health",
          "no-reply@bank.com", "recruiter@bigco.com", "mentor@college.ac.in"]
APPS = ["Spotify", "Microsoft Edge", "Notepad", "Calculator", "Slack", "Discord",
        "Steam", "Chrome", "VLC", "Zoom", "Figma", "Postman", "Obsidian", "Blender",
        "Audacity", "OBS Studio", "Photoshop", "Excel", "Word", "PowerPoint",
        "Telegram", "Signal", "Firefox", "Thunderbird", "GIMP", "Inkscape",
        "Docker Desktop", "Task Manager", "File Explorer", "Settings"]
SUBFOLDERS = ["invoices", "receipts", "screenshots", "notes", "archive", "reports",
              "photos-2026", "tax", "designs", "drafts", "clients", "contracts",
              "backups", "exports", "resumes", "slides", "recordings", "logs",
              "assets", "mockups", "research", "travel", "bills", "certificates"]
FILES = ["README.md", "budget.xlsx", "notes.txt", "report.pdf", "index.html",
         "resume.docx", "config.json", "todo.md", "invoice-2026.pdf", "data.csv",
         "styles.css", "main.py", "package.json", "notes-2026.md", "slides.pptx",
         "contract.docx", "receipt.png", "changelog.md", "schema.sql", "app.log"]
QUERIES = ["budget", "report", "invoice", "resume", "tax return", "meeting notes",
           "screenshot", "presentation", "contract", "payslip", "insurance policy",
           "boarding pass", "bank statement", "project plan", "design mockup",
           "lecture notes", "recipe", "warranty", "lease agreement", "certificate"]
SLACK_CHANNELS = ["eng", "general", "design", "random", "support", "release",
                  "product", "ops", "marketing", "hiring", "incidents", "standup",
                  "backend", "frontend", "qa", "data", "security", "announcements"]
TOPICS = ["the demo tomorrow", "the Q3 numbers", "next week's schedule",
          "the design review", "the contract", "the release plan",
          "the budget approval", "the client feedback", "the migration plan",
          "the hiring round", "the outage postmortem", "the pricing change",
          "the conference talk", "the onboarding docs", "the security audit",
          "the invoice that's overdue", "the renewal terms", "the sprint goals"]


def synth_examples(guard, stats, per_template=14):
    """Templated (request → correct call) pairs over the real schemas.

    Only tools whose arguments can be produced correctly from the phrasing get a
    template. Inventing args for a tool we cannot fill honestly would teach
    exactly the hallucination this whole exercise is trying to remove.
    """
    T = []

    def add(tool, make):
        if tool in SCHEMAS:
            T.append((tool, make))

    add("open_app", lambda: (
        random.choice([f"open {a}", f"launch {a}", f"start {a}", f"can you open {a}?",
                       f"please open {a}"]).format(),
        {"appName": a}) if (a := random.choice(APPS)) else None)

    def _folder():
        name, path = random.choice(list(WIN_FOLDERS.items()))
        return name, path

    add("open_app", lambda: (
        (lambda n, p: (random.choice([f"open my {n} folder", f"open {n}",
                                      f"show me my {n} folder"]), {"appName": p}))(*_folder())))

    add("list_directory", lambda: (
        (lambda n, p: (random.choice([f"list what's in my {n} folder",
                                      f"what files are in my {n}?",
                                      f"show me the contents of my {n} folder"]),
                       {"path": p}))(*_folder())))

    add("create_folder", lambda: (
        (lambda n, p, s: (random.choice([f"make a folder called {s} in my {n}",
                                         f"create a new folder named {s} inside {n}",
                                         f"add a {s} folder to my {n}"]),
                          {"path": os.path.join(p, s)}))(
            *_folder(), random.choice(SUBFOLDERS))))

    add("read_file", lambda: (
        (lambda n, p, f: (random.choice([f"read {f} in my {n} folder",
                                         f"open {f} from {n} and show me what's inside",
                                         f"what's in {f} in my {n}?"]),
                          {"path": os.path.join(p, f)}))(
            *_folder(), random.choice(FILES))))

    add("search_files", lambda: (
        (lambda q: (random.choice([f"find a file named {q}", f"search my files for {q}",
                                   f"look for {q} on my computer",
                                   f"where is my {q} file?"]), {"query": q}))(
            random.choice(QUERIES))))

    add("open_folder_in_editor", lambda: (
        (lambda n, p, s: (random.choice([f"open my {n}/{s} folder in VS Code",
                                         f"open {s} in {n} in vscode"]),
                          {"path": os.path.join(p, s), "editor": "vscode"}))(
            *_folder(), random.choice(SUBFOLDERS))))

    add("send_whatsapp_message", lambda: (
        (lambda who, t: (random.choice([f"message {who} on WhatsApp that I'll be late",
                                        f"tell {who} on whatsapp I'm running behind",
                                        f"whatsapp {who} that I'll be 10 minutes late"]),
                         {"contact": who,
                          "message": "Hey, I'm running about 10 minutes late — see you soon!"}))(
            random.choice(PEOPLE), None)))

    add("open_whatsapp_chat", lambda: (
        (lambda who: (random.choice([f"open my WhatsApp chat with {who}",
                                     f"pull up the whatsapp conversation with {who}",
                                     f"show me my whatsapp thread with {who}"]),
                      {"contact": who}))(random.choice(PEOPLE))))

    add("create_email_draft", lambda: (
        (lambda e, t: (random.choice([f"draft an email to {e} about {t}",
                                      f"write a draft email to {e} regarding {t}",
                                      f"prepare an email to {e} about {t}"]),
                       {"to": e, "subject": t.capitalize(),
                        "body": f"Hi,\n\nI wanted to follow up about {t}.\n\nBest regards"}))(
            random.choice(EMAILS), random.choice(TOPICS))))

    add("send_email", lambda: (
        (lambda e, t: (random.choice([f"send an email to {e} about {t}",
                                      f"email {e} about {t}"]),
                       {"to": e,
                        "body": f"Hi,\n\nQuick note about {t}.\n\nThanks"}))(
            random.choice(EMAILS), random.choice(TOPICS))))

    add("find_email_thread", lambda: (
        (lambda q: (random.choice([f"find the email thread about {q}",
                                   f"search my email for {q}",
                                   f"where's the email about {q}?"]), {"query": q}))(
            random.choice(QUERIES + TOPICS))))

    add("control_calendar", lambda: (
        (lambda t: (random.choice([f"schedule a meeting tomorrow at 3pm called {t}",
                                   f"put {t} on my calendar for tomorrow at 3",
                                   f"book {t} tomorrow afternoon at 3pm"]),
                    {"action": "create",
                     "eventDetails": {"title": t, "start": "2026-08-12T15:00:00"}}))(
            random.choice(["Design Review", "Standup", "1:1", "Retro", "Demo"]))))

    add("control_calendar", lambda: (
        random.choice(["what's on my calendar today?", "show me today's schedule",
                       "what meetings do I have today?"]), {"action": "list"}))

    add("research_web", lambda: (
        (lambda q: (random.choice([f"look up {q} online", f"research {q} on the web",
                                   f"search the web for {q}"]), {"query": q}))(
            random.choice(["the price of an RTX 4060", "qwen2.5 benchmarks",
                           "electron auto-update best practices",
                           "LoRA vs QLoRA memory use"]))))

    add("browser_navigate", lambda: (
        (lambda u: (random.choice([f"go to {u} in the browser",
                                   f"navigate to {u}"]), {"url": f"https://{u}"}))(
            random.choice(["github.com", "news.ycombinator.com", "example.com"]))))

    add("check_repo_exists", lambda: (
        (lambda r: (random.choice([f"does the repo {r} exist on github?",
                                   f"check if {r} is on github"]), {"repo": r}))(
            random.choice(["openui-web", "Satyabrat2005/Openui", "acme/site"]))))

    add("list_open_prs", lambda: (
        random.choice(["list the open pull requests", "what PRs are open?",
                       "show me open pull requests"]), {}))

    add("get_pr_diff", lambda: (
        (lambda n: (random.choice([f"show me the diff for PR {n}",
                                   f"what changed in pull request {n}?"]),
                    {"pr_number": n}))(random.randint(2, 400))))

    add("post_pr_comment", lambda: (
        (lambda n, c: (f'leave a comment on PR {n} saying {c}',
                       {"pr_number": n, "comment": c}))(
            random.randint(2, 400),
            random.choice(["looks good to me", "please add a test",
                           "nice cleanup", "can you rebase this?"]))))

    # Broader tool coverage. Every wrong_tool error in the baseline was the model
    # reaching for a neighbouring tool, so the fix is showing it more of the
    # surface — not more copies of the tools it already gets right.

    add("delete_file", lambda: (
        (lambda n, p, f: (random.choice([f"delete {f} from my {n} folder",
                                         f"remove {f} in {n}",
                                         f"get rid of {f} in my {n}"]),
                          {"path": os.path.join(p, f)}))(
            *_folder(), random.choice(FILES))))

    add("move_file", lambda: (
        (lambda p1, p2, f, s: (
            random.choice([f"move {f} from {p1[0]} to {p1[0]}/{s}",
                           f"put {f} into the {s} folder in my {p1[0]}"]),
            {"source": os.path.join(p1[1], f),
             "destination": os.path.join(p1[1], s, f)}))(
            _folder(), None, random.choice(FILES), random.choice(SUBFOLDERS))))

    add("copy_file", lambda: (
        (lambda p1, f, s: (
            random.choice([f"copy {f} in my {p1[0]} into the {s} folder",
                           f"make a copy of {f} from {p1[0]} in {s}"]),
            {"source": os.path.join(p1[1], f),
             "destination": os.path.join(p1[1], s, f)}))(
            _folder(), random.choice(FILES), random.choice(SUBFOLDERS))))

    add("write_file", lambda: (
        (lambda p1, f, t: (
            random.choice([f"create a file called {f} in my {p1[0]} with a note about {t}",
                           f"write {f} in {p1[0]} saying something about {t}"]),
            {"path": os.path.join(p1[1], f),
             "content": f"Notes about {t}.\n"}))(
            _folder(), random.choice(FILES), random.choice(TOPICS))))

    add("list_apps", lambda: (
        random.choice(["what apps are installed?", "list the applications on this pc",
                       "show me my installed programs", "which apps do I have?"]), {}))

    add("read_clipboard", lambda: (
        random.choice(["what's on my clipboard?", "read my clipboard",
                       "show me what I copied", "paste what I just copied"]), {}))

    add("write_clipboard", lambda: (
        (lambda t: (random.choice([f"copy '{t}' to my clipboard",
                                   f"put {t} on the clipboard"]), {"text": t}))(
            random.choice(["the meeting link", "my address", "the invoice number",
                           "the tracking id", "the wifi password"]))))

    add("search_local_files", lambda: (
        (lambda q: (random.choice([f"search inside my documents for {q}",
                                   f"find files containing {q}",
                                   f"grep my files for {q}"]), {"query": q}))(
            random.choice(QUERIES))))

    add("browser_extract_text", lambda: (
        random.choice(["read the text on this page", "extract the text from the page",
                       "what does this page say?"]), {}))

    add("browser_screenshot", lambda: (
        random.choice(["take a screenshot of this page", "capture the current page",
                       "screenshot the browser"]), {}))

    add("create_document", lambda: (
        (lambda t: (random.choice([f"create a word document about {t}",
                                   f"make me a docx summarising {t}"]),
                    {"title": t.capitalize(),
                     "path": os.path.join(WIN_FOLDERS["documents"],
                                          re.sub(r"[^a-z0-9]+", "-",
                                                 t.lower()).strip("-") + ".docx")}))(
            random.choice(TOPICS))))

    add("create_presentation", lambda: (
        (lambda t: (random.choice([f"make a slide deck about {t}",
                                   f"create a presentation on {t}"]),
                    {"title": t.capitalize(),
                     "path": os.path.join(WIN_FOLDERS["documents"],
                                          re.sub(r"[^a-z0-9]+", "-",
                                                 t.lower()).strip("-") + ".pptx")}))(
            random.choice(TOPICS))))

    add("write_spreadsheet", lambda: (
        (lambda t: (random.choice([f"make a spreadsheet tracking {t}",
                                   f"create an xlsx for {t}"]),
                    {"path": os.path.join(WIN_FOLDERS["documents"],
                                          re.sub(r"[^a-z0-9]+", "-",
                                                 t.lower()).strip("-") + ".xlsx")}))(
            random.choice(QUERIES))))

    add("run_python", lambda: (
        (lambda a, b: (random.choice([f"what is {a} times {b}? use python",
                                      f"compute {a}*{b} with python"]),
                       {"code": f"print({a}*{b})"}))(
            random.randint(11, 999), random.randint(11, 999))))

    # ── cross-channel surface, added 2026-09-05 ──────────────────────────────
    #
    # WHY: the 2026-08 corpus had 485 messaging rows out of 2731, all of them
    # WhatsApp and Gmail basics, and ZERO rows for summarize_inbox,
    # broadcast_message, send_summary_email, link_contact, list_contacts or any
    # Slack/Telegram tool. The product those tools make is the one the model is
    # supposed to serve, so it was being fine-tuned away from its own job. These
    # templates are written against the REAL schemas — see the argument names in
    # src/main/inboxSummary.ts, broadcast.ts, contacts.ts, slack.ts, telegram.ts
    # — because a row that teaches an argument shape the executor rejects is
    # worse than no row at all.

    add("summarize_inbox", lambda: (
        random.choice(["what did I miss today?",
                       "give me a rundown of everything waiting on me",
                       "anything new across my apps?",
                       "bring me up to speed on my messages",
                       "what's waiting for me this morning?"]),
        {}))

    add("summarize_inbox", lambda: (
        (lambda who: (random.choice([f"anything waiting from {who}?",
                                     f"did {who} get back to me anywhere?",
                                     f"has {who} sent me anything recently?",
                                     f"show me what {who} has been saying"]),
                      {"contact": who}))(random.choice(PEOPLE))))

    add("summarize_inbox", lambda: (
        (lambda chans: (random.choice([f"what came in on {' and '.join(chans)}?",
                                       f"catch me up on just {' and '.join(chans)}"]),
                        {"channels": list(chans)}))(
            random.choice([("slack", "gmail"), ("whatsapp", "telegram"),
                           ("slack",), ("gmail",), ("whatsapp", "slack")]))))

    add("send_summary_email", lambda: (
        (lambda e: (random.choice([f"forward that rundown to {e}",
                                   f"put that summary in an email to {e}",
                                   f"email what you just wrote to {e}"]),
                    {"recipient": e,
                     "summary": "Here is the summary you asked for.",
                     "subject": "Summary"}))(random.choice(EMAILS))))

    add("broadcast_message", lambda: (
        (lambda a, b: (random.choice([
            f"get word to {a} and {b} on all their apps that the deadline moved",
            f"reach {a} and {b} everywhere: the deadline has moved",
            f"push a note to {a} and {b} across every channel about the new deadline"]),
            {"message": "Heads up — the deadline has moved. Details to follow.",
             "to": [a, b]}))(*random.sample(PEOPLE, 2))))

    add("broadcast_message", lambda: (
        (lambda who: (random.choice([f"get this to {who} on whatever apps they use: I'm on my way",
                                     f"reach {who} on all channels — say I'm on my way"]),
                      {"message": "I'm on my way.", "to": [who]}))(
            random.choice(PEOPLE))))

    # ONE template that samples the channel rather than three per-channel ones.
    # Three templates would draw 3x per_template rows and make link_contact the
    # single most-represented tool in the corpus (360 rows at --per-template 120,
    # against ~120 for everything else), which teaches the model that linking is
    # the usual answer. The channel enum is exercised either way.
    def _link_handle(channel, who):
        if channel == "telegram":
            return str(random.randint(100000000, 999999999))
        if channel == "gmail":
            return random.choice(EMAILS)
        if channel == "slack":
            return "@" + random.choice(PEOPLE).lower()
        # WhatsApp exposes a chat DISPLAY name, so the handle is a name — but not
        # the same string the user just used, or the row degenerates into
        # "the whatsapp handle nikhil is Nikhil" and teaches nothing.
        return who + " " + random.choice(
            ["Sharma", "Iyer", "Khan", "Patel", "Rao", "Menon", "Bose", "Nair",
             "(work)", "(cousin)", "(landlord)", "from college"])

    add("link_contact", lambda: (
        (lambda who, ch, h: (random.choice([f"{ch} {h} belongs to {who}",
                                            f"save {ch} {h} under {who}",
                                            f"that {ch} handle {h} is {who}, remember it",
                                            f"file {h} on {ch} under {who}",
                                            f"{h} is {who} — note that for {ch}"]),
                             {"name": who, "channel": ch, "handle": h}))(
            *(lambda who, ch: (who, ch, _link_handle(ch, who)))(
                random.choice(PEOPLE),
                random.choice(["telegram", "gmail", "slack", "whatsapp"])))))

    add("list_contacts", lambda: (
        random.choice(["who have you got saved?",
                       "show me the people you know about",
                       "what handles do you have on file?",
                       "list everyone you can reach",
                       "who's in your contact list?",
                       "print the people you've got linked",
                       "run through the contacts you know",
                       "what names have been linked so far?",
                       "show the address book",
                       "who can you actually message?",
                       "what's saved in contacts?",
                       "give me the list of linked people"]),
        {}))

    add("send_telegram_message", lambda: (
        (lambda cid: (random.choice([f"ping telegram {cid}: leaving now",
                                     f"drop a telegram to {cid} saying I'm leaving now",
                                     f"tell telegram chat {cid} I'm heading out"]),
                      {"chat_id": str(cid), "text": "Leaving now."}))(
            random.randint(100000000, 999999999))))

    add("read_telegram_messages", lambda: (
        (lambda cid: (random.choice([f"what's been said in telegram {cid}?",
                                     f"pull up the recent telegram messages in {cid}",
                                     f"show me telegram chat {cid}"]),
                      {"chat_id": str(cid)}))(
            random.randint(100000000, 999999999))))

    add("list_telegram_chats", lambda: (
        random.choice(["which telegram chats are available?",
                       "show me the telegram conversations you can reach",
                       "what's in telegram right now?",
                       "list the telegram chats you can see",
                       "which telegram ids do you have?",
                       "who has messaged the telegram bot?",
                       "what telegram conversations are open to you?",
                       "show the telegram chat ids",
                       "which telegram groups is the bot in?",
                       "what can you reach on telegram?",
                       "give me the telegram chat list",
                       "any telegram chats visible?"]),
        {}))

    add("send_slack_message", lambda: (
        (lambda ch, t: (random.choice([f"drop a note in #{ch}: {t}",
                                       f"put {t} in the {ch} channel on slack",
                                       f"say {t} in #{ch}"]),
                        {"channel": ch, "text": t}))(
            random.choice(SLACK_CHANNELS),
            random.choice(["the build is green again",
                           "review is open for anyone with time",
                           "lunch is being ordered in ten minutes",
                           "the incident is resolved"]))))

    add("read_slack_channel", lambda: (
        (lambda ch: (random.choice([f"what's happening in #{ch}?",
                                    f"read me the recent messages in {ch} on slack",
                                    f"catch me up on the {ch} channel",
                                    f"what have people been saying in #{ch}?",
                                    f"pull the last messages from slack {ch}",
                                    f"anything going on in #{ch}?"]),
                     {"channel": ch}))(
            random.choice(SLACK_CHANNELS))))

    add("list_slack_channels", lambda: (
        random.choice(["which slack channels can you see?",
                       "list the slack channels available to you",
                       "what channels exist in slack?",
                       "show me the slack channel list",
                       "which slack channels is the token in?",
                       "what slack channels do you have access to?",
                       "enumerate the slack channels",
                       "give me the channels on slack",
                       "what's the channel list look like?",
                       "which channels can you post to?"]),
        {}))

    add("search_slack", lambda: (
        (lambda q: (random.choice([f"look through slack for {q}",
                                   f"dig up the slack messages about {q}"]),
                    {"query": q}))(random.choice(TOPICS))))

    # Dedup on (tool, normalised request). The generators sample from finite
    # pools, so without this, raising --per-template inflates the row count with
    # copies rather than adding information — a bigger number that teaches the
    # model nothing new. Attempts are bounded so a saturated template stops
    # instead of spinning.
    rows = []
    seen = set()
    for tool, make in T:
        made_count = 0
        attempts = 0
        max_attempts = per_template * 25
        while made_count < per_template and attempts < max_attempts:
            attempts += 1
            made = make()
            if not made:
                continue
            user, args = made
            key = (tool, norm(user))
            if key in seen:
                stats["synth_dedup_skipped"] += 1
                continue
            if guard.is_contaminated(user):
                stats["synth_blocked_contamination"] += 1
                continue
            seen.add(key)
            made_count += 1
            rows.append({
                "source": "synthetic", "kind": "tool_call", "tool": tool,
                "messages": [
                    {"role": "system", "content": compact_system(tool)},
                    {"role": "user", "content": user},
                    {"role": "assistant", "content": call_json(tool, args)},
                ]})
            stats["synth_tool"] += 1
        if made_count < per_template:
            stats["synth_templates_saturated"] += 1

    # No-tool examples: the false-positive half. Without these, a model trained
    # only on tool calls learns to call a tool for everything.
    NO_TOOL = [
        ("what's the difference between RAM and VRAM?",
         "VRAM is memory on the graphics card, used by the GPU for model weights and "
         "framebuffers; RAM is main system memory used by the CPU. They are separate "
         "pools, which is why a model can fit in RAM but not in VRAM."),
        ("thanks, that's everything",
         "Happy to help — just say the word if anything else comes up."),
        ("write me a short haiku about slow builds",
         "Compiler humming\nthe progress bar barely moves —\ncoffee gets colder."),
        ("why does my laptop get hot when I run a local model?",
         "Running a model locally keeps the GPU and CPU near full utilisation for the "
         "whole generation, and sustained load in a thin laptop chassis means the "
         "cooling system runs hard. It is expected, though heavy sustained use will "
         "throttle clocks once it hits thermal limits."),
        ("what does a LoRA adapter actually change?",
         "A LoRA adapter leaves the base weights frozen and learns small low-rank "
         "matrices that are added to selected projections. You ship a few megabytes "
         "of adapter instead of a full fine-tuned copy of the model."),
        ("can you explain what you are?",
         "I'm OpenUI, a desktop assistant. I can act on your computer through tools — "
         "opening apps and folders, searching files, drafting email, managing your "
         "calendar and messages — or just answer questions like this one."),
        ("is it worth upgrading from 8GB to 16GB of VRAM?",
         "For local models, yes — 8 GB forces heavy quantisation and small context "
         "windows, and once the KV cache stops fitting the model spills to CPU and "
         "slows down sharply. 16 GB removes most of that pressure."),
        ("what's 17 * 23?",
         "391."),
    ]
    for user, ans in NO_TOOL:
        if guard.is_contaminated(user):
            stats["synth_blocked_contamination"] += 1
            continue
        for _ in range(max(1, per_template // 2)):
            rows.append({
                "source": "synthetic", "kind": "no_tool", "tool": None,
                "messages": [
                    {"role": "system", "content": compact_system(None)},
                    {"role": "user", "content": user},
                    {"role": "assistant", "content": ans},
                ]})
            stats["synth_no_tool"] += 1

    # ── refusals, added 2026-09-05 ───────────────────────────────────────────
    #
    # WHY THIS KIND EXISTS. The 2026-08 corpus had SIX kinds and none of them was
    # a refusal, and the model trained on it lost its refusals — it routed "delete
    # everything in C:\Windows\System32" through computer_use and mailed a
    # password to the address a prompt injection supplied. A corpus in which every
    # single label is an action is a corpus that says "always act".
    #
    # These are NOT safety boilerplate bolted on afterwards. Each one is a tool's
    # OWN documented contract, quoted from the schema the app ships:
    #
    #   broadcast_message  "there is no 'send to everyone' mode, and this REFUSES
    #                       rather than choosing recipients for you; if the user
    #                       was vague about who, ask them"
    #   link_contact       "never guess a chat id or an email address, ask the
    #                       user and link it"
    #   send_summary_email "if the person is known but has no address linked, this
    #                       REFUSES and tells you to ask the user which address"
    #
    # So a model that emits the call anyway is not being bold, it is emitting a
    # call the executor will reject — after having invented a stranger's address
    # to put in it. The label here is a plain-language question, never JSON.
    #
    # The paired positives matter as much: broadcast_message WITH named people,
    # send_telegram_message WITH a chat_id in the request, and send_summary_email
    # WITH an address are all generated above. Training the refusal without them
    # would just teach the model to never send anything, which is the failure mode
    # the safety gate calls VACUOUS.
    R = []

    def add_refusal(tool, make):
        if tool in SCHEMAS:
            R.append((tool, make))

    UNNAMED = ["everyone", "everybody", "the whole team", "them all", "the group",
               "all of them", "the others", "the rest of the team"]
    NEWS = ["we're closed on Monday", "the meeting is off", "the demo is postponed",
            "I'll be late", "the deadline moved", "the office is shut tomorrow",
            "the release is delayed", "the venue changed"]

    add_refusal("broadcast_message", lambda: (
        (lambda g, n: random.choice([f"let {g} know {n}",
                                     f"tell {g} that {n}",
                                     f"get word to {g}: {n}"]))(
            random.choice(UNNAMED), random.choice(NEWS)),
        random.choice([
            "Before I send that anywhere — who should get it? I don't choose "
            "recipients on my own, so give me the names and I'll send it to each "
            "of them on every channel they're reachable on.",
            "Happy to send it, but I need the names. There's no send-to-everyone "
            "option — tell me who you mean and I'll put it out to all of them at once.",
            "Who is \"everyone\" here? Name the people and I'll send the same "
            "message across each channel they have linked.",
        ])))

    add_refusal("send_telegram_message", lambda: (
        (lambda who: (
            random.choice([f"telegram {who} that I'm running late",
                           f"send {who} a telegram about tomorrow",
                           f"message {who} on telegram for me"]),
            random.choice([
                f"I can't message {who} on Telegram yet — a bot can only write to a "
                f"chat it has already seen, and I don't have a chat id for {who}. "
                f"If you tell me the id (or have {who} message the bot first) I'll "
                f"save it against their name and send it.",
                f"I don't have a Telegram chat id for {who}, and I'm not going to "
                f"guess one — that would message a stranger. Send me the id and "
                f"I'll link it to {who} and go from there.",
            ])))(random.choice(PEOPLE))))

    add_refusal("link_contact", lambda: (
        (lambda who: (
            random.choice([f"email {who} the notes from today",
                           f"send {who} an email about the schedule change"]),
            random.choice([
                f"I don't have an email address on file for {who}. Which address "
                f"should I use? I'll save it against their name so this works "
                f"straight away next time.",
                f"No Gmail address is linked to {who} yet, and I won't invent one. "
                f"Give me the address and I'll link it and send the email.",
            ])))(random.choice(PEOPLE))))

    add_refusal("send_summary_email", lambda: (
        (lambda who: (
            random.choice([f"mail that summary over to {who}",
                           f"forward the rundown to {who}"]),
            random.choice([
                f"I have the summary ready, but there's no email address linked to "
                f"{who}. Tell me which address to use and it goes out.",
                f"I know who {who} is, but not their email. What address should I "
                f"send it to?",
            ])))(random.choice(PEOPLE))))

    add_refusal("summarize_inbox", lambda: (
        (lambda who: (
            random.choice([f"is there anything from {who}?",
                           f"did {who} write to me?"]),
            f"I don't have {who} on file, so I can't tell which handle is theirs — "
            f"and guessing would show you someone else's messages. Point me at one "
            f"of their handles (WhatsApp name, Telegram id, Slack handle or email) "
            f"and I'll remember it, then check everywhere for you."))(
        random.choice(["Jordan", "Casey", "Alex P", "Sam T", "Riley", "Morgan",
                       "Devon", "Quinn", "Harper", "Rowan", "Emerson", "Blake",
                       "Marlowe", "Sasha K", "Noor", "Ilya"]))))

    # HOW MANY. A third of a normal template's target, which lands the refusal
    # share around 6-7% of the corpus. The dose matters in both directions: at 0%
    # the last tune lost its refusals outright, and at a large share the model
    # learns to decline work it can actually do — which the safety gate would
    # report as VACUOUS rather than safe, and which the positive cases in the
    # eval set (bc-01, tg-01, sum-01, link-01) are there to catch.
    for tool, make in R:
        made_count = 0
        attempts = 0
        seen_r = set()
        target = max(1, per_template // 3)
        while made_count < target and attempts < target * 25:
            attempts += 1
            made = make()
            if not made:
                continue
            user, answer = made
            key = norm(user)
            if key in seen_r:
                stats["synth_dedup_skipped"] += 1
                continue
            if guard.is_contaminated(user):
                stats["synth_blocked_contamination"] += 1
                continue
            # A refusal label that contains a tool call would teach the opposite
            # of what it is here for. Cheap to assert, catastrophic to miss.
            assert "{" not in answer, f"refusal label for {tool} contains JSON: {answer[:80]}"
            seen_r.add(key)
            made_count += 1
            rows.append({
                "source": "synthetic", "kind": "refusal", "tool": tool,
                "messages": [
                    # The tool IS on the surface. The point is not that the model
                    # cannot see it — it is that seeing it is not a reason to call
                    # it with arguments the request never supplied.
                    {"role": "system", "content": compact_system(tool)},
                    {"role": "user", "content": user},
                    {"role": "assistant", "content": answer},
                ]})
            stats["synth_refusal"] += 1

    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.path.join(
        os.environ.get("APPDATA", ""), "OpenUI", "openui.db"))
    ap.add_argument("--out", default=os.path.join(HERE, "data", "train.jsonl"))
    ap.add_argument("--holdout", default=os.path.join(HERE, "data", "holdout.jsonl"))
    ap.add_argument("--per-template", type=int, default=14)
    ap.add_argument("--distractors", type=int, default=6,
                    help="tool schemas sampled into each example prompt; the 3B QLoRA "
                         "seq ceiling on an 8GB card is 1024 tokens")
    ap.add_argument("--holdout-frac", type=float, default=0.08)
    ap.add_argument("--prompt-dir", default=None,
                    help="directory of per-case prompts captured from the running app; "
                         "schemas are the union across them. Defaults to "
                         + os.path.basename(DEFAULT_PROMPT_DIR))
    args = ap.parse_args()

    global N_DISTRACTORS, PREAMBLE, SCHEMAS, POSTAMBLE, PROMPT_SOURCE
    N_DISTRACTORS = args.distractors
    if args.prompt_dir:
        PROMPT_SOURCE = args.prompt_dir
        PREAMBLE, SCHEMAS, POSTAMBLE = load_prompt_parts(args.prompt_dir)

    stats = {k: 0 for k in [
        "real_success", "real_repaired", "real_recovery", "real_failure_undrepairable",
        "real_skipped_unknown_tool", "real_blocked_contamination",
        "synth_tool", "synth_no_tool", "synth_refusal", "synth_blocked_contamination",
        "synth_dedup_skipped", "synth_templates_saturated"]}
    guard = EvalGuard()

    real = []
    if os.path.exists(args.db):
        real = load_real(args.db, guard, stats)
    else:
        print(f"WARNING: no db at {args.db} — real trajectories unavailable",
              file=sys.stderr)

    synth = synth_examples(guard, stats, args.per_template)
    rows = real + synth
    random.shuffle(rows)

    n_hold = int(len(rows) * args.holdout_frac)
    hold, train = rows[:n_hold], rows[n_hold:]

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    for path, data in ((args.out, train), (args.holdout, hold)):
        with open(path, "w", encoding="utf-8") as fh:
            for r in data:
                fh.write(json.dumps(r, ensure_ascii=False) + "\n")

    print("=" * 62)
    print("DATASET")
    print("=" * 62)
    for k, v in stats.items():
        print(f"  {k:34s} {v}")
    print(f"  {'-'*34}")
    print(f"  {'REAL rows':34s} {len(real)}")
    print(f"  {'SYNTHETIC rows':34s} {len(synth)}")
    print(f"  {'TOTAL':34s} {len(rows)}   (train {len(train)} / holdout {len(hold)})")
    print(f"  {'real share':34s} {100*len(real)/max(len(rows),1):.1f}%")
    print(f"  {'synthetic share':34s} {100*len(synth)/max(len(rows),1):.1f}%")

    # Composition table — printed so a before/after is legible without writing a
    # one-off script each time. The messaging line is the one this phase exists
    # to move; the synthetic share is the one that limits what any conclusion
    # drawn from a run on this corpus is worth.
    print(f"\n  {'schemas from':34s} {PROMPT_SOURCE}")
    print(f"  {'tools with schemas':34s} {len(SCHEMAS)}")
    by_kind = {}
    by_tool = {}
    for r in rows:
        by_kind[r["kind"]] = by_kind.get(r["kind"], 0) + 1
        if r.get("tool"):
            by_tool[r["tool"]] = by_tool.get(r["tool"], 0) + 1
    print("\n  rows by kind:")
    for k, v in sorted(by_kind.items(), key=lambda x: -x[1]):
        print(f"    {k:32s} {v}")

    CROSS_CHANNEL = ["summarize_inbox", "send_summary_email", "broadcast_message",
                     "link_contact", "list_contacts", "unlink_contact",
                     "send_telegram_message", "read_telegram_messages",
                     "list_telegram_chats", "send_slack_message",
                     "read_slack_channel", "list_slack_channels", "search_slack"]
    MESSAGING = CROSS_CHANNEL + ["send_whatsapp_message", "open_whatsapp_chat",
                                 "send_email", "create_email_draft",
                                 "find_email_thread", "draft_refund_email"]
    print("\n  cross-channel rows (0 for every one of these before 2026-09-05):")
    for t in CROSS_CHANNEL:
        mark = " " if t in by_tool else "!"
        print(f"   {mark}{t:32s} {by_tool.get(t, 0)}")
    msg_rows = sum(by_tool.get(t, 0) for t in MESSAGING)
    print(f"\n  {'messaging rows (all channels)':34s} {msg_rows} "
          f"({100*msg_rows/max(len(rows),1):.1f}%)")
    xc_rows = sum(by_tool.get(t, 0) for t in CROSS_CHANNEL)
    print(f"  {'of which cross-channel':34s} {xc_rows} "
          f"({100*xc_rows/max(len(rows),1):.1f}%)")

    if guard.blocked:
        print(f"\n  contamination blocks ({len(guard.blocked)}):")
        for t, why in guard.blocked[:10]:
            print(f"    [{why}] {t[:60]}")
    print(f"\nwrote {args.out} and {args.holdout}")


if __name__ == "__main__":
    main()
