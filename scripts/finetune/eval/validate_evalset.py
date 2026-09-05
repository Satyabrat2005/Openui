#!/usr/bin/env python3
"""validate_evalset.py — check every expectation in evalset.json against the REAL
tool schemas captured from the running app.

This exists because it already went wrong once: two GitHub cases required args
named `number`/`body` when the real schemas are `pr_number`/`comment`, so the
model was scored as failing for emitting the correct call. An eval that is wrong
in the model's favour is bad; one that is wrong against the model is worse,
because it manufactures a problem for fine-tuning to "fix".

Run this whenever evalset.json or the tool surface changes. Exit 1 on any error.

SOURCE OF SCHEMAS — CHANGED 2026-09-05. This used to read `system_prompt.txt`,
the single full-surface prompt. Since the per-turn tool grouping landed (#161)
the app never builds that prompt: each turn carries only the groups its user text
selected, so no single captured file lists every tool, and validating against a
stale full-surface capture would "check" the eval set against a surface the app
stopped sending. `--prompt-dir` therefore takes the UNION over the per-case
prompts captured by capture_prompts.cjs — the same union run_eval.py builds for
its `known` set, from the same files it scores against.

    python validate_evalset.py --prompt-dir ./captured-prompts-2026-09-05

`system_prompt.txt` remains the fallback so the old invocation still runs, but a
union of fresh captures is the truthful input.
"""
import argparse
import glob
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def _split_params(sig):
    """Split a rendered parameter list on TOP-LEVEL commas.

    FIXED 2026-09-05. The old parser was `^- ([a-z_0-9]+)\\(([^)]*)\\)`, which
    stops at the first ')' — and eight tools render an enum inside their
    parameter list:

        link_contact(name: string, channel: string (whatsapp|telegram|slack|gmail), handle: string)

    `[^)]*` ends at the enum's own ')', so `handle` vanished and the validator
    reported the eval set as wrong when it was right. That is the exact failure
    this file exists to prevent, one level up: an eval that is wrong against the
    MODEL is bad, and a validator that is wrong against the EVAL SET is the same
    mistake wearing a different hat. The others it silently truncated:
    browser_history, browser_scroll, connect_browser, control_calendar,
    merge_pr, open_folder_in_editor, unlink_contact.
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


def _signature(text, start):
    """Return the balanced contents of the parameter list opening at `start`."""
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "(":
            depth += 1
        elif text[i] == ")":
            depth -= 1
            if depth == 0:
                return text[start + 1:i]
        elif text[i] == "\n":
            return None  # a tool line never wraps mid-signature
    return None


def parse_schemas(text, into=None):
    schemas = {} if into is None else into
    for m in re.finditer(r"^- ([a-z_0-9]+)\(", text, re.M):
        sig = _signature(text, m.end() - 1)
        if sig is None:
            continue
        params = [p.split(":")[0].strip().rstrip("?") for p in _split_params(sig)]
        # A tool can appear in several per-case prompts; keep the richest
        # parameter list rather than whichever file happened to be read last.
        if len(params) >= len(schemas.get(m.group(1), [])):
            schemas[m.group(1)] = params
    return schemas


def load_schemas(path):
    return parse_schemas(open(path, encoding="utf-8").read())


def load_schemas_from_dir(dirpath):
    """Union of every per-case captured prompt in `dirpath`."""
    schemas = {}
    files = sorted(glob.glob(os.path.join(dirpath, "*.txt")))
    for f in files:
        parse_schemas(open(f, encoding="utf-8").read(), schemas)
    return schemas, len(files)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt-dir", default=None,
                    help="directory of per-case captured prompts; schemas are the union "
                         "across them (the app no longer builds a full-surface prompt)")
    cli = ap.parse_args()

    if cli.prompt_dir:
        if not os.path.isdir(cli.prompt_dir):
            print("--prompt-dir %s is not a directory" % cli.prompt_dir, file=sys.stderr)
            return 2
        schemas, nfiles = load_schemas_from_dir(cli.prompt_dir)
        if not schemas:
            print("no tool schemas found in %s — are these captured prompts?" % cli.prompt_dir,
                  file=sys.stderr)
            return 2
        source = "%d captured per-case prompt(s) in %s" % (nfiles, cli.prompt_dir)
        return validate(schemas, source)

    prompt_file = os.path.join(HERE, "system_prompt.txt")
    if not os.path.exists(prompt_file):
        print("system_prompt.txt missing — capture it from the real app first", file=sys.stderr)
        return 2
    return validate(load_schemas(prompt_file), "system_prompt.txt (single full-surface capture)")


# Defects in the FROZEN 44, found 2026-09-05 by the args_required-vs-alt_tools
# check below and deliberately NOT fixed. evalset.json's own protocol forbids
# editing an existing case, and these three are load-bearing for the comparability
# of every baseline in this directory — changing them would silently re-grade runs
# recorded in August against models that cannot be re-run.
#
# They are real, not cosmetic. `web-02` has scored a correct alt-tool call as
# missing_args in SIX recorded runs, including both frozen baselines:
#
#     results-BASELINE-qwen3.5.json   web-02  missing_args
#         {"tool": "open_app", "args": {"appName": "Microsoft Edge"}}
#
# `open_app` is declared in web-02's own alt_tools and `appName` is the only
# parameter it has; `url` is not one. So the accuracy of every run in this
# directory is understated by up to one case, in the same direction for all of
# them. The fix belongs in a phase that re-baselines everything at once.
#
# Listed rather than silenced: they are printed on every run, and anything NOT in
# this list still fails the validator.
KNOWN_FROZEN_DEFECTS = {
    ("cal-03", "args_required 'action' is not a param of open_cancellation"),
    ("web-01", "args_required 'query' is not a param of connect_browser"),
    ("web-02", "args_required 'url' is not a param of connect_browser"),
    ("web-02", "args_required 'url' is not a param of open_app"),
}


def _is_known(cid, message):
    return any(cid == kid and message.startswith(kmsg)
               for kid, kmsg in KNOWN_FROZEN_DEFECTS)


def validate(schemas, source):
    ev = json.load(open(os.path.join(HERE, "evalset.json"), encoding="utf-8"))

    errors = []
    seen = set()
    for c in ev["cases"]:
        cid = c["id"]
        if cid in seen:
            errors.append(f"{cid}: duplicate id")
        seen.add(cid)
        e = c["expect"]

        if e["kind"] == "tool":
            for t in [e["tool"]] + list(e.get("alt_tools", [])):
                if t not in schemas:
                    errors.append(f"{cid}: tool {t!r} is not in the captured system prompt")
            # args_required is checked by run_eval against WHICHEVER tool the
            # model called, so it has to be a parameter of every acceptable one —
            # not just the primary. Checking only the primary is how sum-01
            # shipped for an afternoon declaring alt_tools send_email /
            # create_email_draft alongside args_required recipient/summary: a
            # correct send_email call scored missing_args, and this validator
            # said the case was fine. Added 2026-09-05.
            for t in [e["tool"]] + list(e.get("alt_tools", [])):
                real_t = schemas.get(t, [])
                if not real_t:
                    continue  # the missing-tool error above already fired
                for a in e.get("args_required", []):
                    if a not in real_t:
                        errors.append(
                            f"{cid}: args_required {a!r} is not a param of {t} "
                            f"(real: {real_t}) — run_eval checks args_required against "
                            f"whichever acceptable tool was called, so a correct call to "
                            f"{t} would score missing_args"
                        )
            real = schemas.get(e["tool"], [])
            pa = e.get("path_arg")
            if pa and pa not in real:
                errors.append(f"{cid}: path_arg {pa!r} not a param of {e['tool']} (real: {real})")
            for k in (e.get("args_must_match") or {}):
                if k not in real:
                    errors.append(
                        f"{cid}: args_must_match key {k!r} not a param of {e['tool']} (real: {real})"
                    )
            continue

        # kind == "tool_or_clarify" — validated here since 2026-09-05. It was
        # previously skipped, which is the wrong way round: this kind carries FOUR
        # tool-shaped fields instead of one, so it has four times the surface for
        # the `pr_number`/`number` class of mistake this file exists to catch.
        if e["kind"] == "tool_or_clarify":
            tools = list(e.get("tools", []))
            if not tools:
                errors.append(f"{cid}: tool_or_clarify with no `tools` — nothing can score correct")
            for t in tools:
                if t not in schemas:
                    errors.append(f"{cid}: tool {t!r} is not in the captured system prompt")
            for t in e.get("sending_tools", []):
                if t not in tools:
                    # Unreachable check: the wrong_tool test runs first, so a
                    # sending tool outside `tools` can never reach the
                    # fabricated_recipient rule the case was written for.
                    errors.append(
                        f"{cid}: sending_tool {t!r} is not in `tools`, so the "
                        f"fabricated_recipient check for it is unreachable"
                    )
            for t in e.get("sending_tools", []):
                real = schemas.get(t, [])
                for a in e.get("recipient_args", ["to"]):
                    if real and a not in real:
                        errors.append(
                            f"{cid}: recipient_arg {a!r} not a param of {t} (real: {real})"
                        )
            for tool_name, required in (e.get("args_required_per_tool") or {}).items():
                if tool_name not in tools:
                    errors.append(
                        f"{cid}: args_required_per_tool names {tool_name!r}, which is not in `tools`"
                    )
                real = schemas.get(tool_name, [])
                for a in required:
                    if real and a not in real:
                        errors.append(
                            f"{cid}: args_required_per_tool {a!r} not a param of "
                            f"{tool_name} (real: {real})"
                        )
            pat = e.get("clarify_must_match")
            if pat:
                try:
                    re.compile(pat)
                except re.error as err:
                    errors.append(f"{cid}: clarify_must_match is not a valid regex ({err})")
            else:
                errors.append(
                    f"{cid}: tool_or_clarify with no clarify_must_match — a bare refusal "
                    f"that never asks for the missing thing would score correct"
                )

    known, fresh = [], []
    for e in errors:
        cid = e.split(":", 1)[0]
        rest = e.split(": ", 1)[1] if ": " in e else e
        (known if _is_known(cid, rest) else fresh).append(e)

    print(f"{len(ev['cases'])} cases, {len(schemas)} tools from {source}")
    if known:
        print(f"\n{len(known)} KNOWN defect(s) in the frozen 44, not fixed here "
              f"(see KNOWN_FROZEN_DEFECTS):")
        for e in known:
            print("  ~", e)
    if fresh:
        print(f"\n{len(fresh)} PROBLEM(S):")
        for e in fresh:
            print("  -", e)
        return 1
    print("\nall expectations reference real tools and real parameter names")
    return 0


if __name__ == "__main__":
    sys.exit(main())
