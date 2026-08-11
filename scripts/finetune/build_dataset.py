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

def load_prompt_parts():
    sp = open(os.path.join(EVAL, "system_prompt.txt"), encoding="utf-8").read()
    i = sp.find("Available tools:")
    j = sp.find("Examples — map the request")
    preamble = sp[:i].rstrip()
    tool_lines = [l for l in sp[i:j].split("\n") if l.startswith("- ")]
    postamble = sp[j:]
    schemas = {}
    for line in tool_lines:
        m = re.match(r"^- ([a-z_0-9]+)\(([^)]*)\)", line)
        if not m:
            continue
        params = []
        for p in m.group(2).split(","):
            p = p.strip()
            if not p:
                continue
            key = p.split(":")[0].strip()
            params.append({"name": key.rstrip("?"), "optional": key.endswith("?")})
        schemas[m.group(1)] = {"line": line, "params": params}
    return preamble, schemas, postamble


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
    args = ap.parse_args()

    global N_DISTRACTORS
    N_DISTRACTORS = args.distractors

    stats = {k: 0 for k in [
        "real_success", "real_repaired", "real_recovery", "real_failure_undrepairable",
        "real_skipped_unknown_tool", "real_blocked_contamination",
        "synth_tool", "synth_no_tool", "synth_blocked_contamination",
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
    if guard.blocked:
        print(f"\n  contamination blocks ({len(guard.blocked)}):")
        for t, why in guard.blocked[:10]:
            print(f"    [{why}] {t[:60]}")
    print(f"\nwrote {args.out} and {args.holdout}")


if __name__ == "__main__":
    main()
