#!/usr/bin/env python3
"""prompt_freshness.py — refuse to score against prompts the app no longer builds.

WHY THIS EXISTS. On 2026-08-30 the benchmark's prompts/ directory was found to be
15 days stale. Every one of the 20 prompts was missing two shipped changes: the
`inbox` tool group (added 2026-08-17) and the reworded control_calendar schema
from the pre-launch calendar gate. The effect was not cosmetic — on the tg-01
turn, the stale prompt produced NO tool call at seeds 0, 1 and 2, and the
regenerated one produced the correct send_telegram_message at all three. An 80
character difference in a sentence unrelated to Telegram flipped the case
outright.

Left unchecked that does not corrupt one case, it corrupts the comparison: GPT,
Claude and Gemini would all be scored on a prompt Splen does not send, so the
resulting table measures a prompt nobody ships.

prompts/ is deliberately gitignored ("never commit locally-generated per-case
prompts" — .gitignore:70). Committing a fresh copy would therefore fix nothing:
the next person to clone still generates their own, and the failure mode is
forgetting to. The durable fix is to make staleness loud instead of silent, so
this compares the manifest's timestamp against every input that can change a
prompt's bytes and refuses to proceed when one is newer.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))

# Everything whose contents can change a generated prompt. agent.ts holds
# buildDefaultSystemPrompt and the tool schemas; toolGroups.ts decides which
# groups a turn selects and carries the "Also available" group labels;
# channelMemory.ts renders the memory block; the generator and the taskset
# decide which prompts exist at all.
PROMPT_INPUTS = [
    os.path.join(REPO, "src", "main", "agent.ts"),
    os.path.join(REPO, "src", "main", "toolGroups.ts"),
    os.path.join(REPO, "src", "main", "channelMemory.ts"),
    os.path.join(HERE, "generate_prompts.test.ts"),
]

# taskset.json is checked by CONTENT, not mtime. Only three of its fields can
# change a prompt's bytes - the case id, the user turn selectToolGroups routes
# on, and the memory block - so editing an `expect` (as the mail-03 fix did)
# must not raise a false alarm that trains people to ignore this check. The
# generator writes the matching fingerprint into manifest.json.
TASKSET = os.path.join(HERE, "taskset.json")


def taskset_fingerprint(path=None):
    import hashlib

    with open(path or TASKSET, encoding="utf-8") as fh:
        cases = json.load(fh)["cases"]
    # Must serialise exactly as generate_prompts.test.ts does:
    # JSON.stringify(cases.map(c => [c.id, c.prompt, c.memory ?? null]))
    blob = json.dumps([[c["id"], c["prompt"], c.get("memory")] for c in cases],
                      separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()

REGEN = "npx vitest run --config scripts/benchmark/vitest.gen.config.ts"


def check(prompt_dir=None, inputs=None):
    """Returns (ok, message). ok=False means do not score against these prompts."""
    prompt_dir = prompt_dir or os.path.join(HERE, "prompts")
    inputs = inputs if inputs is not None else PROMPT_INPUTS

    manifest = os.path.join(prompt_dir, "manifest.json")
    if not os.path.isdir(prompt_dir) or not os.path.isfile(manifest):
        return False, ("prompts/ has not been generated.\n  Generate them with:\n    %s" % REGEN)

    with open(manifest, encoding="utf-8") as fh:
        man = json.load(fh)

    generated_at = os.path.getmtime(manifest)
    newer = []

    recorded = man.get("tasksetFingerprint")
    if recorded is None:
        newer.append(("scripts/benchmark/taskset.json",
                      "manifest predates the fingerprint field - regenerate once"))
    elif recorded != taskset_fingerprint():
        newer.append(("scripts/benchmark/taskset.json",
                      "a case id, user turn or memory block changed since generation"))
    for path in inputs:
        if not os.path.exists(path):
            # A missing input is itself a reason to stop: the check cannot tell
            # whether the prompts are current, and silently passing would be the
            # exact failure this file exists to prevent.
            newer.append((os.path.relpath(path, REPO).replace("\\", "/"), "MISSING"))
            continue
        mtime = os.path.getmtime(path)
        if mtime > generated_at:
            newer.append((os.path.relpath(path, REPO).replace("\\", "/"),
                          "modified %.1f h after the prompts were generated"
                          % ((mtime - generated_at) / 3600.0)))
    if newer:
        stamp = man.get("generated", "unknown")
        lines = ["prompts/ is STALE — generated %s, but these inputs changed since:" % stamp]
        lines += ["    %-44s %s" % (p, why) for p, why in newer]
        lines.append("")
        lines.append("  Scoring against these would measure a prompt the app no longer")
        lines.append("  sends. Regenerate first:")
        lines.append("    %s" % REGEN)
        return False, "\n".join(lines)

    return True, "prompts/ is current"


if __name__ == "__main__":
    import sys

    ok, msg = check()
    print(msg)
    sys.exit(0 if ok else 1)
