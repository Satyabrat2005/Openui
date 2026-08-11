#!/usr/bin/env python3
"""validate_evalset.py — check every expectation in evalset.json against the REAL
tool schemas captured from the running app.

This exists because it already went wrong once: two GitHub cases required args
named `number`/`body` when the real schemas are `pr_number`/`comment`, so the
model was scored as failing for emitting the correct call. An eval that is wrong
in the model's favour is bad; one that is wrong against the model is worse,
because it manufactures a problem for fine-tuning to "fix".

Run this whenever evalset.json or the tool surface changes. Exit 1 on any error.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def load_schemas(path):
    sp = open(path, encoding="utf-8").read()
    schemas = {}
    for m in re.finditer(r"^- ([a-z_0-9]+)\(([^)]*)\)", sp, re.M):
        params = []
        for p in m.group(2).split(","):
            p = p.strip()
            if not p:
                continue
            key = p.split(":")[0].strip()
            params.append(key.rstrip("?"))
        schemas[m.group(1)] = params
    return schemas


def main():
    prompt_file = os.path.join(HERE, "system_prompt.txt")
    if not os.path.exists(prompt_file):
        print("system_prompt.txt missing — capture it from the real app first", file=sys.stderr)
        return 2
    schemas = load_schemas(prompt_file)
    ev = json.load(open(os.path.join(HERE, "evalset.json"), encoding="utf-8"))

    errors = []
    seen = set()
    for c in ev["cases"]:
        cid = c["id"]
        if cid in seen:
            errors.append(f"{cid}: duplicate id")
        seen.add(cid)
        e = c["expect"]
        if e["kind"] != "tool":
            continue
        for t in [e["tool"]] + list(e.get("alt_tools", [])):
            if t not in schemas:
                errors.append(f"{cid}: tool {t!r} is not in the captured system prompt")
        real = schemas.get(e["tool"], [])
        for a in e.get("args_required", []):
            if a not in real:
                errors.append(
                    f"{cid}: args_required {a!r} not a param of {e['tool']} (real: {real})"
                )
        pa = e.get("path_arg")
        if pa and pa not in real:
            errors.append(f"{cid}: path_arg {pa!r} not a param of {e['tool']} (real: {real})")
        for k in (e.get("args_must_match") or {}):
            if k not in real:
                errors.append(
                    f"{cid}: args_must_match key {k!r} not a param of {e['tool']} (real: {real})"
                )

    print(f"{len(ev['cases'])} cases, {len(schemas)} tools in the captured prompt")
    if errors:
        print(f"\n{len(errors)} PROBLEM(S):")
        for e in errors:
            print("  -", e)
        return 1
    print("all expectations reference real tools and real parameter names")
    return 0


if __name__ == "__main__":
    sys.exit(main())
