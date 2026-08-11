#!/usr/bin/env python3
"""run_eval.py — score a local Ollama model against OpenUI's frozen eval set.

The point of this file is that the SAME code scores the baseline and every
fine-tuned candidate. If you change the scoring, re-run the baseline too — a
delta measured against a moved goalpost is not a delta.

Fidelity: the system prompt is NOT reconstructed here. It is captured from the
real running app by ollama-capture-proxy.cjs (captures.jsonl) and replayed
verbatim, so the tool list, the trimming rules and num_ctx are exactly what the
app sends. A reconstruction would drift the moment a tool is added — which is
the very class of bug this phase is chasing.

Safety: replies are PARSED, never executed. The eval set deliberately contains
"send an email" / "message X on WhatsApp" prompts; running those for real would
send real messages. We score the decision, not the consequence.

Parsing mirrors src/main/toolCallParser.ts (fence unwrap, balanced-brace
extraction, loose-JSON repair, tool/tool_name/name + args/arguments/parameters/
input aliases, and the pass-2 recovery of a call embedded in prose).

Usage:
  python run_eval.py --model qwen3.5:latest --label baseline-general
  python run_eval.py --model openui-qwen-coder:v1 --label tuned-v1
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_HOST = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")


# ── parser (mirror of src/main/toolCallParser.ts) ────────────────────────────

def extract_first_json_object(text):
    start = text.find("{")
    if start == -1:
        return None
    depth = 0
    in_string = False
    escaped = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return None


def repair_loose_json(src):
    """Escape control chars that sit INSIDE a string value (models emit literal
    newlines in write_file content). Structural whitespace is left alone."""
    out = []
    in_string = False
    escaped = False
    for ch in src:
        if in_string:
            if escaped:
                out.append(ch)
                escaped = False
                continue
            if ch == "\\":
                out.append(ch)
                escaped = True
                continue
            if ch == '"':
                out.append(ch)
                in_string = False
                continue
            if ch == "\n":
                out.append("\\n")
            elif ch == "\r":
                out.append("\\r")
            elif ch == "\t":
                out.append("\\t")
            else:
                out.append(ch)
            continue
        if ch == '"':
            in_string = True
        out.append(ch)
    return "".join(out)


def try_parse_json(src):
    try:
        return json.loads(src)
    except Exception:
        try:
            return json.loads(repair_loose_json(src))
        except Exception:
            return None


def obj_to_tool_call(parsed, require_known, known):
    if not isinstance(parsed, dict):
        return None
    tool_raw = parsed.get("tool") or parsed.get("tool_name") or parsed.get("name")
    if not isinstance(tool_raw, str) or not tool_raw.strip():
        return None
    tool = tool_raw.strip()
    if require_known and tool not in known:
        return None
    args_raw = None
    for k in ("args", "arguments", "parameters", "input"):
        if k in parsed:
            args_raw = parsed[k]
            break
    args = args_raw if isinstance(args_raw, dict) else {}
    return {"tool": tool, "args": args}


FENCE_RE = re.compile(r"^```(?:json)?\s*([\s\S]*?)\s*```$", re.I)


def parse_tool_call(text, known):
    """Returns (call|None, how) where how ∈ clean|fenced|prose|none."""
    if not text:
        return None, "none"
    candidate = text.strip()
    fenced = False
    m = FENCE_RE.match(candidate)
    if m:
        candidate = m.group(1).strip()
        fenced = True

    if candidate.startswith("{"):
        js = extract_first_json_object(candidate)
        if js:
            parsed = try_parse_json(js)
            if parsed is not None:
                call = obj_to_tool_call(parsed, False, known)
                if call:
                    return call, ("fenced" if fenced else "clean")

    # pass 2: a call embedded in prose anywhere
    start = text.find("{")
    while start != -1:
        js = extract_first_json_object(text[start:])
        if js:
            parsed = try_parse_json(js)
            if parsed is not None:
                call = obj_to_tool_call(parsed, True, known)
                if call:
                    return call, "prose"
        start = text.find("{", start + 1)
    return None, "none"


def looks_like_attempted_tool_call(text):
    """Was this MEANT to be a tool call, even though nothing parsed out of it?

    Mirrors looksLikeAttemptedToolCall() in toolCallParser.ts, plus one case that
    function does not need but the eval does: an UNBALANCED JSON-shaped reply.
    Observed for real — a stray doubled quote ("body": ""Hello…) puts the closing
    braces inside a string, so brace-matching never terminates. The app drops
    that call silently; for scoring it is a malformed tool call, not prose,
    because counting it as "answered in prose" would flatter the model.
    """
    if not text:
        return False
    candidate = text.strip()
    m = FENCE_RE.match(candidate)
    if m:
        candidate = m.group(1).strip()
    if not candidate.startswith("{"):
        return False
    js = extract_first_json_object(candidate)
    if not js:
        return True  # JSON-shaped but unbalanced → attempted-but-broken
    parsed = try_parse_json(js)
    if parsed is None:
        return True  # balanced but broken → attempted, not prose
    if not isinstance(parsed, dict):
        return False
    return obj_to_tool_call(parsed, False, set()) is None


# ── hallucinated-success detection ───────────────────────────────────────────

HALLUCINATION_RE = re.compile(
    r"\b(i (?:have|'ve) (?:opened|created|sent|drafted|scheduled|deleted|added)"
    r"|has been (?:opened|created|sent|scheduled|added)"
    r"|i(?:'ve| have) (?:just )?(?:gone ahead and )?(?:done|completed)"
    r"|successfully (?:opened|created|sent|scheduled))\b",
    re.I,
)
FAKE_TOOL_RESULT_RE = re.compile(r"^\s*TOOL RESULT", re.M)


# ── scoring ──────────────────────────────────────────────────────────────────

POSIX_PATH_RE = re.compile(r"^(?:/(?:Users|home|tmp|workspace|var|opt|mnt)\b|~/|/$)")


def score_case(case, reply, known):
    exp = case["expect"]
    kind = exp["kind"]
    call, how = parse_tool_call(reply, known)
    flags = []

    if FAKE_TOOL_RESULT_RE.search(reply):
        flags.append("fake_tool_result")

    if kind == "no_tool":
        if call is not None:
            return "wrong_tool", flags + ["called_%s_when_none_expected" % call["tool"]], call, how
        if looks_like_attempted_tool_call(reply):
            return "malformed_json", flags + ["json_blob_no_tool_key"], None, how
        return "correct", flags, None, how

    if kind == "builder":
        # Builder routing is decided by BUILD_RE in TypeScript BEFORE the model
        # is consulted, so it is scored separately by score_builder_routing().
        return "n/a_router", flags, call, how

    # kind == tool
    if call is None:
        if looks_like_attempted_tool_call(reply):
            return "malformed_json", flags, None, how
        if HALLUCINATION_RE.search(reply):
            return "hallucinated_success", flags, None, how
        return "no_tool_emitted", flags, None, how

    if how == "fenced":
        flags.append("protocol_fenced")
    elif how == "prose":
        flags.append("protocol_prose_wrapped")

    allowed = [exp["tool"]] + list(exp.get("alt_tools", []))
    if call["tool"] not in allowed:
        return "wrong_tool", flags + ["got_" + call["tool"]], call, how

    args = call["args"]
    required = exp.get("args_required", [])
    missing = [k for k in required if k not in args or args[k] in ("", None)]
    if required and not args:
        return "empty_args", flags, call, how
    if missing:
        return "missing_args", flags + ["missing_" + ",".join(missing)], call, how

    # path sanity — the recorded failure mode was POSIX paths on Windows
    parg = exp.get("path_arg")
    if parg and isinstance(args.get(parg), str):
        if POSIX_PATH_RE.match(args[parg].strip()):
            return "bad_path", flags + ["posix_path:" + args[parg][:40]], call, how

    for k, pat in (exp.get("args_must_match") or {}).items():
        v = args.get(k)
        if not isinstance(v, str) or not re.search(pat.replace("(?i)", ""), v, re.I):
            return "wrong_args", flags + ["%s=%r !~ %s" % (k, v, pat)], call, how

    mn = exp.get("args_must_not_match") or {}
    if "any" in mn:
        blob = json.dumps(args)
        if re.search(mn["any"], blob, re.I):
            return "wrong_args", flags + ["matched_forbidden:" + mn["any"]], call, how

    return "correct", flags, call, how


# ── ollama ───────────────────────────────────────────────────────────────────

def ollama_chat(host, model, system, user, num_ctx, timeout=600, seed=0):
    """One non-streaming turn.

    temperature=0 + a fixed seed is a deliberate departure from the app's
    defaults. Sampling noise was measured to flip individual verdicts between
    identical runs (mail-01 went wrong_tool → malformed_json), and a before/after
    delta smaller than that noise is not a result. Greedy decoding makes the
    comparison mean something; the residual run-to-run variance is measured and
    reported as the noise floor rather than assumed to be zero.
    """
    body = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "think": False,          # agent.ts sets this — qwen3 streams <think> otherwise
        "options": {"num_ctx": num_ctx, "temperature": 0, "seed": seed, "top_p": 1},
        "stream": False,
    }).encode("utf-8")
    req = urllib.request.Request(
        host + "/api/chat", data=body, headers={"Content-Type": "application/json"}
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        payload = json.loads(r.read().decode("utf-8"))
    return payload.get("message", {}).get("content", ""), time.time() - t0, payload


def resolve_num_ctx(coding, prompt_chars):
    """Mirror of resolveNumCtx() in src/main/agent.ts."""
    floor = 16384 if coding else 8192
    needed = -(-prompt_chars // 4) + 2048
    if needed <= floor:
        return floor
    import math
    return min(2 ** math.ceil(math.log2(needed)), 32768)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--label", required=True)
    ap.add_argument("--host", default=DEFAULT_HOST)
    ap.add_argument("--evalset", default=os.path.join(HERE, "evalset.json"))
    ap.add_argument("--prompt-file", default=os.path.join(HERE, "system_prompt.txt"))
    ap.add_argument("--out", default=None)
    ap.add_argument("--coding", action="store_true", help="use the CODING num_ctx floor")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    ev = json.load(open(args.evalset, encoding="utf-8"))
    cases = ev["cases"]
    if args.limit:
        cases = cases[: args.limit]

    if not os.path.exists(args.prompt_file):
        print(
            "ERROR: %s not found. Capture the REAL system prompt first:\n"
            "  1. node ollama-capture-proxy.cjs\n"
            "  2. run the app with OLLAMA_HOST=http://127.0.0.1:11435\n"
            "  3. python extract_prompt.py" % args.prompt_file,
            file=sys.stderr,
        )
        sys.exit(2)
    system = open(args.prompt_file, encoding="utf-8").read()

    known = set(re.findall(r"^- ([a-z_0-9]+)\(", system, re.M))
    print("system prompt: %d chars (~%d tokens), %d tools parsed"
          % (len(system), len(system) // 4, len(known)))

    results = []
    counts = {}
    t_start = time.time()
    for i, case in enumerate(cases, 1):
        if case["expect"]["kind"] == "builder":
            results.append({**case, "verdict": "n/a_router", "flags": [], "reply": None,
                            "latency_s": None})
            counts["n/a_router"] = counts.get("n/a_router", 0) + 1
            print("[%2d/%d] %-9s %-14s (router-decided, not model)"
                  % (i, len(cases), case["id"], "n/a_router"))
            continue

        num_ctx = resolve_num_ctx(args.coding, len(system) + len(case["prompt"]))
        try:
            reply, dt, payload = ollama_chat(args.host, args.model, system,
                                             case["prompt"], num_ctx)
        except Exception as err:
            results.append({**case, "verdict": "error", "flags": [str(err)[:200]],
                            "reply": None, "latency_s": None})
            counts["error"] = counts.get("error", 0) + 1
            print("[%2d/%d] %-9s ERROR %s" % (i, len(cases), case["id"], str(err)[:80]))
            continue

        verdict, flags, call, how = score_case(case, reply, known)
        counts[verdict] = counts.get(verdict, 0) + 1
        results.append({
            **case, "verdict": verdict, "flags": flags, "how": how,
            "call": call, "reply": reply[:1200], "latency_s": round(dt, 2),
            "num_ctx": num_ctx,
            "eval_count": payload.get("prompt_eval_count"),
        })
        print("[%2d/%d] %-9s %-20s %5.1fs %s"
              % (i, len(cases), case["id"], verdict, dt, ",".join(flags[:2])))

    scored = [r for r in results if r["verdict"] not in ("n/a_router",)]
    lat = [r["latency_s"] for r in results if r.get("latency_s")]
    summary = {
        "label": args.label,
        "model": args.model,
        "when": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "system_prompt_chars": len(system),
        "system_prompt_est_tokens": len(system) // 4,
        "tools_in_prompt": len(known),
        "cases_total": len(cases),
        "cases_scored": len(scored),
        "counts": counts,
        "correct": counts.get("correct", 0),
        "accuracy_pct": round(100.0 * counts.get("correct", 0) / max(len(scored), 1), 1),
        "median_latency_s": round(sorted(lat)[len(lat) // 2], 2) if lat else None,
        "total_wall_s": round(time.time() - t_start, 1),
    }
    out = args.out or os.path.join(HERE, "results-%s.json" % args.label)
    json.dump({"summary": summary, "results": results}, open(out, "w", encoding="utf-8"),
              indent=2)
    print("\n=== %s (%s) ===" % (args.label, args.model))
    for k, v in sorted(counts.items(), key=lambda x: -x[1]):
        print("  %-22s %d" % (k, v))
    print("  accuracy over scored cases: %s%%" % summary["accuracy_pct"])
    print("  median latency: %ss" % summary["median_latency_s"])
    print("wrote", out)


if __name__ == "__main__":
    main()
