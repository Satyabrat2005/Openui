#!/usr/bin/env python3
"""validate_taskset.py — check every expectation in taskset.json against the REAL
tool schemas, as they appear in the generated per-case prompts.

Same reasoning as scripts/finetune/eval/validate_evalset.py, which exists because
it already went wrong once: two cases required args named `number`/`body` when
the real schemas said `pr_number`/`comment`, so a model emitting the CORRECT call
was scored as failing. An eval that is wrong in the model's favour is bad; one
that is wrong against the model is worse, because it manufactures a deficit.

Three checks, run against the prompt that case will actually be sent:
  1. the expected tool is present in that prompt's tool list at all
     (a case whose tool was filtered out by tool-grouping is unscorable)
  2. every args_required name exists on that tool's real schema
  3. every args_must_match / args_must_not_match key is a real arg name too

Run after any change to taskset.json or the tool surface:
    python scripts/benchmark/validate_taskset.py
Exit 1 on any error.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROMPT_DIR = os.path.join(HERE, "prompts")


def load_schemas(prompt_path):
    """{tool_name: [arg names]} parsed from a prompt's "- name(a: t, b: t)" lines."""
    text = open(prompt_path, encoding="utf-8").read()
    schemas = {}
    for m in re.finditer(r"^- ([a-z_0-9]+)\(([^)]*)\)", text, re.M):
        params = []
        for p in m.group(2).split(","):
            p = p.strip()
            if not p:
                continue
            params.append(p.split(":")[0].strip().rstrip("?"))
        schemas[m.group(1)] = params
    return schemas


def main():
    taskset = json.load(open(os.path.join(HERE, "taskset.json"), encoding="utf-8"))
    if not os.path.isdir(PROMPT_DIR):
        print(
            "prompts/ missing — generate them first:\n"
            "  npx vitest run --config scripts/benchmark/vitest.gen.config.ts",
            file=sys.stderr,
        )
        return 2

    errors = []
    checked = 0

    for case in taskset["cases"]:
        cid = case["id"]
        exp = case["expect"]
        prompt_path = os.path.join(PROMPT_DIR, cid + ".txt")
        if not os.path.exists(prompt_path):
            errors.append("%s: no generated prompt at %s" % (cid, prompt_path))
            continue

        schemas = load_schemas(prompt_path)
        if not schemas:
            errors.append("%s: prompt has no parseable tool list" % cid)
            continue

        if exp["kind"] != "tool":
            continue

        candidates = [exp["tool"]] + list(exp.get("alt_tools", []))
        present = [t for t in candidates if t in schemas]
        if not present:
            errors.append(
                "%s: none of %s appear in its own prompt — tool-grouping filtered "
                "them out, so this case cannot be answered correctly by anyone"
                % (cid, candidates)
            )
            continue

        # Validate arg names against the PRIMARY tool (the one we expect).
        tool = exp["tool"]
        if tool not in schemas:
            # Only alt_tools survived grouping; that is legal, skip arg checks.
            continue
        real_args = schemas[tool]
        checked += 1

        for key in exp.get("args_required", []):
            if key not in real_args:
                errors.append(
                    "%s: args_required %r is not an arg of %s (real args: %s)"
                    % (cid, key, tool, real_args)
                )

        for key in (exp.get("args_must_match") or {}):
            if key not in real_args:
                errors.append(
                    "%s: args_must_match key %r is not an arg of %s (real args: %s)"
                    % (cid, key, tool, real_args)
                )

        for key in (exp.get("args_must_not_match") or {}):
            if key != "any" and key not in real_args:
                errors.append(
                    "%s: args_must_not_match key %r is not an arg of %s (real args: %s)"
                    % (cid, key, tool, real_args)
                )

    if errors:
        print("TASKSET INVALID — %d problem(s):\n" % len(errors), file=sys.stderr)
        for e in errors:
            print("  " + e, file=sys.stderr)
        return 1

    print(
        "taskset OK — %d cases, %d tool-cases arg-checked against their own prompts"
        % (len(taskset["cases"]), checked)
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
