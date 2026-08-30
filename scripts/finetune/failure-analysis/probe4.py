#!/usr/bin/env python3
"""probe4.py — STEP 2 (isolation): which single element actually drives tg-01?

probe.py [C] flipped tg-01 to a correct call by removing TWO things at once:
the sensitive-action "Hard rules" block AND the schema's confirmation clause.
probe3.py then showed the schema clause is NOT the driver (strengthening it did
not fix telegram; weakening it did not break whatsapp). So either the Hard-rules
block is doing all the work, or the difference is in the USER TURN, not the
prompt at all — tg-01 says "send a telegram message ...", wa-01 says "message
Ashu on WhatsApp ...".

Two axes, one change each, so whichever flips is the one that matters:
  J. prompt axis  - remove the Hard-rules block alone; remove the schema clause alone.
  K. wording axis - swap the verb phrasing between the two channels.
"""
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from probe import chat, load_prompt, MODEL, CONFIRM_SENTENCES, HARD_RULE_START, HARD_RULE_END  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
BENCH = os.path.join(REPO, "scripts", "benchmark")
sys.path.insert(0, BENCH)
sys.path.insert(0, os.path.join(REPO, "scripts", "finetune", "eval"))
from run_eval import score_case  # noqa: E402
from run_benchmark import repair_invalid_escapes, known_tool_names  # noqa: E402


def drop_hard_rules(prompt):
    a, b = prompt.index(HARD_RULE_START), prompt.index(HARD_RULE_END)
    return prompt[:a] + prompt[b:]


def drop_schema_clause(prompt):
    out = prompt
    for s in CONFIRM_SENTENCES:
        out = out.replace(" " + s, "").replace(s, "")
    return out


def run(label, case, system, user, note):
    reply, secs = chat(system, user)
    verdict, flags, call, how = score_case(
        case, repair_invalid_escapes(reply), known_tool_names(system)
    )
    row = {"probe": label, "note": note, "user_turn": user, "verdict": verdict,
           "flags": list(flags), "tool": (call or {}).get("tool"),
           "latency_s": secs, "reply": reply}
    print("  %-34s %-18s tool=%-26s %5.1fs" % (label, verdict, row["tool"], secs))
    return row


def main():
    cases = {c["id"]: c for c in json.load(
        open(os.path.join(BENCH, "taskset.json"), encoding="utf-8"))["cases"]}
    tg, wa = cases["tg-01"], cases["wa-01"]
    tgp, wap = load_prompt("tg-01"), load_prompt("wa-01")
    rows = []

    print("\n[J] PROMPT AXIS - one block removed at a time")
    rows.append(run("tg-01:hard-rules-removed", tg, drop_hard_rules(tgp), tg["prompt"],
                    "sensitive-action Hard rules block gone; schema clause intact"))
    rows.append(run("tg-01:schema-clause-removed", tg, drop_schema_clause(tgp), tg["prompt"],
                    "schema confirm clause gone; Hard rules intact"))

    print("\n[K] WORDING AXIS - swap the verb phrasing between the channels")
    rows.append(run("tg-01:phrased-like-wa-01", tg, tgp,
                    "message telegram chat 123456789 that I am on my way",
                    "telegram, phrased the way wa-01 phrases it (no leading 'send a')"))
    rows.append(run("wa-01:phrased-like-tg-01", wa, wap,
                    "send a whatsapp message to Ashu saying I'll be 10 minutes late",
                    "whatsapp, phrased the way tg-01 phrases it (leading 'send a')"))

    print("\n[L] does a numeric id vs a name matter?")
    rows.append(run("tg-01:named-recipient", tg, tgp,
                    "send a telegram message to Ashu saying I am on my way",
                    "numeric chat_id replaced by a name - NOTE: expected to need a lookup"))

    dest = os.path.join(HERE, "probe4-results.json")
    json.dump({"model": MODEL, "generated": time.strftime("%Y-%m-%dT%H:%M:%S"), "probes": rows},
              open(dest, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    print("\nwrote %s" % dest)
    return 0


if __name__ == "__main__":
    sys.exit(main())
