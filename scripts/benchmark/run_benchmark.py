#!/usr/bin/env python3
"""run_benchmark.py — run the benchmark task set through Splen and the general
assistants (GPT / Claude / Gemini) and report latency, cost and accuracy.

THE THREE NUMBERS ARE REPORTED SEPARATELY AND NEVER BLENDED. There is no
composite score, on purpose: a single headline number is exactly where a
benchmark stops being checkable.

Design decisions that keep this honest, each of which cost something:

  1. ONE SCORER. Accuracy is scored by score_case() imported from
     scripts/finetune/eval/run_eval.py — the same function that scores every
     local-model run in this project. It is imported, never reimplemented, so
     no system can be advantaged by a scoring tweak.

  2. ONE PROMPT PER CASE, SHARED BY EVERY SYSTEM. The per-case system prompt is
     generated from the app's own builder (generate_prompts.test.ts) and handed
     byte-identically to all four systems. Giving the comparison models a
     different (or absent) tool surface would manufacture a win.

  3. REPLIES ARE PARSED, NEVER EXECUTED. The set contains "send an email to my
     manager" and "message Ashu on WhatsApp". We score the decision, not the
     consequence. Nothing here can send a message to a real person.

  4. COST COMES FROM MEASURED TOKENS x VERIFIED LIST PRICE. Providers whose
     pricing entry is not marked verified are reported as "cost: not verified"
     rather than given a guessed number. See pricing.json.

  5. A PROVIDER WITH NO API KEY IS REPORTED AS NOT RUN. It is never estimated,
     never simulated, and never quietly dropped from the results file.

Usage:
    # generate the prompts first (once, and after any tool-surface change)
    npx vitest run --config scripts/benchmark/vitest.gen.config.ts
    python scripts/benchmark/validate_taskset.py

    # then run whichever systems you have access to
    python scripts/benchmark/run_benchmark.py --systems splen
    python scripts/benchmark/run_benchmark.py --systems splen,claude,gpt,gemini

Environment:
    OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY   (per provider)
    OLLAMA_HOST                                            (default 127.0.0.1:11434)
"""
import argparse
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
EVAL_DIR = os.path.join(REPO, "scripts", "finetune", "eval")

# The shared scorer. Importing it (rather than copying it) is the whole point:
# accuracy for Splen and for GPT/Claude/Gemini is decided by identical code.
sys.path.insert(0, EVAL_DIR)
try:
    from run_eval import score_case, parse_tool_call  # noqa: E402
except ImportError as exc:  # pragma: no cover - surfaced to the operator
    print(
        "cannot import the shared scorer from %s: %s\n"
        "The benchmark refuses to run with a reimplemented scorer." % (EVAL_DIR, exc),
        file=sys.stderr,
    )
    raise SystemExit(2)

PROMPT_DIR = os.path.join(HERE, "prompts")
DEFAULT_OLLAMA = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")

# Default model per system. Overridable with --model-<system>.
DEFAULT_MODELS = {
    "splen": "qwen3.5:latest",
    "gpt": "gpt-5",
    "claude": "claude-opus-5",
    "gemini": "gemini-2.5-pro",
}


def http_json(url, payload, headers, timeout=180):
    """POST json, return (parsed, elapsed_seconds). Raises on transport error."""
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("content-type", "application/json")
    for k, v in headers.items():
        req.add_header(k, v)
    start = time.perf_counter()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8")
    elapsed = time.perf_counter() - start
    return json.loads(raw), elapsed


# ── per-provider adapters ────────────────────────────────────────────────────
# Each returns (reply_text, input_tokens, output_tokens, elapsed_seconds).
# Token counts come from the provider's own usage accounting where available;
# None means "the provider did not report it" and the cost is left unknown
# rather than estimated.


def call_splen(model, system, user, host=DEFAULT_OLLAMA):
    """Local Ollama — the model OpenUI/Splen actually ships on."""
    payload = {
        "model": model,
        "stream": False,
        # temperature 0 + fixed seed: verdicts reproduce exactly. Latency does
        # NOT reproduce — see the README's note on that asymmetry.
        "options": {"temperature": 0, "seed": 0, "num_ctx": 8192},
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    data, elapsed = http_json("%s/api/chat" % host, payload, {})
    reply = (data.get("message") or {}).get("content", "")
    return reply, data.get("prompt_eval_count"), data.get("eval_count"), elapsed


def call_gpt(model, system, user):
    key = os.environ.get("OPENAI_API_KEY", "")
    if not key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    data, elapsed = http_json(
        "https://api.openai.com/v1/chat/completions",
        payload,
        {"authorization": "Bearer %s" % key},
    )
    reply = data["choices"][0]["message"].get("content") or ""
    usage = data.get("usage") or {}
    return reply, usage.get("prompt_tokens"), usage.get("completion_tokens"), elapsed


def call_claude(model, system, user):
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")
    payload = {
        "model": model,
        "max_tokens": 2048,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }
    data, elapsed = http_json(
        "https://api.anthropic.com/v1/messages",
        payload,
        {"x-api-key": key, "anthropic-version": "2023-06-01"},
    )
    # A refusal returns 200 with stop_reason "refusal" and possibly empty
    # content — scored as a non-answer rather than crashing the run.
    reply = "".join(
        b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"
    )
    usage = data.get("usage") or {}
    return reply, usage.get("input_tokens"), usage.get("output_tokens"), elapsed


def call_gemini(model, system, user):
    key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or ""
    if not key:
        raise RuntimeError("GEMINI_API_KEY is not set")
    payload = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": user}]}],
        "generationConfig": {"temperature": 0},
    }
    url = "https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent?key=%s" % (
        model,
        key,
    )
    data, elapsed = http_json(url, payload, {})
    parts = (data.get("candidates") or [{}])[0].get("content", {}).get("parts", [])
    reply = "".join(p.get("text", "") for p in parts)
    usage = data.get("usageMetadata") or {}
    return reply, usage.get("promptTokenCount"), usage.get("candidatesTokenCount"), elapsed


ADAPTERS = {
    "splen": call_splen,
    "gpt": call_gpt,
    "claude": call_claude,
    "gemini": call_gemini,
}


def load_pricing():
    with open(os.path.join(HERE, "pricing.json"), encoding="utf-8") as fh:
        return json.load(fh)["providers"]


def cost_for(pricing, system, model, in_tok, out_tok):
    """USD for one action, or a string explaining why it is unknown.

    Returning a STRING rather than 0.0 or None on the unknown paths is
    deliberate — it makes an unverified price impossible to accidentally sum
    into a total, and it carries the reason into the results file.
    """
    entry = pricing.get(system)
    if entry is None:
        return "no pricing entry"
    if not entry.get("verified"):
        return "not verified — check %s" % entry.get("source", "the provider's pricing page")
    prices = (entry.get("models") or {}).get(model)
    if prices is None:
        return "no price recorded for model %r" % model
    if in_tok is None or out_tok is None:
        return "provider did not report token usage"
    return (in_tok / 1e6) * prices["input_per_mtok"] + (out_tok / 1e6) * prices["output_per_mtok"]


# The characters JSON allows immediately after a backslash inside a string.
VALID_JSON_ESCAPES = set('"\\/bfnrt')


def repair_invalid_escapes(src):
    """Mirror toolCallParser.ts's invalid-escape repair.

    WHY THIS EXISTS. The shipped parser (src/main/toolCallParser.ts) treats a
    backslash that does not begin a legal JSON escape as a LITERAL backslash and
    doubles it, so `"tomorrow.\\ Please"` — a model that meant `\\n` and dropped
    the `n` — still yields a usable tool call in the real app. The scorer's own
    repair (run_eval.py::repair_loose_json) escapes literal control characters
    but NOT invalid escapes, so it rejects a call the product would have
    executed fine.

    Leaving that gap in place would make the benchmark measure the harness
    rather than the systems: an otherwise perfect reply is scored
    `malformed_json` purely because of a repair step the product has and the
    scorer does not. It was found the honest way — the same case flipped
    verdicts between two identical runs.

    Applied to EVERY system's reply, so it cannot favour one of them; and
    implemented here rather than by editing run_eval.py so the frozen
    fine-tuning baselines in scripts/finetune/eval stay comparable to each
    other. `\\uXXXX` is left alone: json can already read it.
    """
    out = []
    in_string = False
    escaped = False
    i = 0
    while i < len(src):
        ch = src[i]
        if in_string:
            if escaped:
                out.append(ch)
                escaped = False
                i += 1
                continue
            if ch == "\\":
                nxt = src[i + 1] if i + 1 < len(src) else ""
                if nxt in VALID_JSON_ESCAPES or nxt == "u":
                    out.append(ch)
                    escaped = True
                else:
                    # Not a JSON escape — the model meant a literal backslash.
                    # Deliberately does NOT set `escaped`: the next character is
                    # ordinary content and must still be examined.
                    out.append("\\\\")
                i += 1
                continue
            if ch == '"':
                in_string = False
            out.append(ch)
            i += 1
            continue
        if ch == '"':
            in_string = True
        out.append(ch)
        i += 1
    return "".join(out)


def known_tool_names(prompt_text):
    """Tool names present in this case's own prompt — what the scorer treats as
    a known tool. Parsed from the prompt so the scorer never credits a call to
    a tool the system was never told about."""
    import re

    return set(re.findall(r"^- ([a-z_0-9]+)\(", prompt_text, re.M))


def run_system(system, model, cases, pricing, limit=0):
    results = []
    adapter = ADAPTERS[system]
    for i, case in enumerate(cases):
        if limit and i >= limit:
            break
        prompt_path = os.path.join(PROMPT_DIR, case["id"] + ".txt")
        with open(prompt_path, encoding="utf-8") as fh:
            system_prompt = fh.read()
        known = known_tool_names(system_prompt)

        row = {"id": case["id"], "category": case["category"], "model": model}
        try:
            reply, in_tok, out_tok, elapsed = adapter(model, system_prompt, case["prompt"])
        except Exception as exc:  # noqa: BLE001 — any failure is reported, never hidden
            row.update(
                verdict="ERROR",
                error="%s: %s" % (type(exc).__name__, exc),
                latency_s=None,
                cost_usd="not run",
            )
            results.append(row)
            print("  %-10s ERROR  %s" % (case["id"], row["error"][:80]))
            continue

        # Bring the reply up to the repair level the shipped parser applies
        # before scoring it — same treatment for every system. See
        # repair_invalid_escapes for why the scorer alone is not enough.
        verdict, flags, call, how = score_case(case, repair_invalid_escapes(reply), known)

        # mem-02 is a no_tool case with an extra must_not_match guard: a model
        # that invents a time for Priya is wrong even though it emitted no tool.
        mnm = case["expect"].get("must_not_match")
        if mnm and verdict == "correct":
            import re

            if re.search(mnm, reply, re.I):
                verdict, flags = "hallucinated_fact", list(flags) + ["matched:" + mnm]

        row.update(
            verdict=verdict,
            flags=list(flags),
            latency_s=round(elapsed, 3),
            input_tokens=in_tok,
            output_tokens=out_tok,
            cost_usd=cost_for(pricing, system, model, in_tok, out_tok),
            tool=(call or {}).get("tool"),
            reply=reply[:2000],
        )
        results.append(row)
        print("  %-10s %-22s %6.2fs" % (case["id"], verdict, elapsed))
    return results


def summarize(system, model, rows, core_ids):
    """Latency / cost / accuracy, reported separately. Memory cases are summed
    apart from the headline accuracy — see taskset.json's scoring note."""
    core = [r for r in rows if r["id"] in core_ids]
    mem = [r for r in rows if r["id"] not in core_ids]
    ok = [r for r in core if r["verdict"] == "correct"]
    lat = [r["latency_s"] for r in rows if r.get("latency_s") is not None]
    costs = [r["cost_usd"] for r in rows if isinstance(r.get("cost_usd"), float)]

    # A system that never answered has NO accuracy, which is a different thing
    # from an accuracy of zero. Reporting "0/18" for a provider whose key was
    # missing would read as "it got everything wrong" — the single most
    # misleading cell this table could contain.
    ran = [r for r in rows if r["verdict"] != "ERROR"]
    not_run = len(ran) == 0

    return {
        "system": system,
        "model": model,
        "not_run": not_run,
        "not_run_reason": next((r.get("error") for r in rows if r["verdict"] == "ERROR"), None)
        if not_run
        else None,
        "core_cases": len(core),
        "core_correct": None if not_run else len(ok),
        "core_accuracy_pct": None
        if not_run or not core
        else round(100.0 * len(ok) / len(core), 1),
        "memory_cases": len(mem),
        "memory_correct": sum(1 for r in mem if r["verdict"] == "correct"),
        "latency_median_s": round(statistics.median(lat), 3) if lat else None,
        "latency_mean_s": round(statistics.fmean(lat), 3) if lat else None,
        "latency_max_s": round(max(lat), 3) if lat else None,
        "cost_total_usd": round(sum(costs), 6) if costs else None,
        "cost_per_action_usd": round(sum(costs) / len(costs), 8) if costs else None,
        "cost_note": None
        if costs
        else next(
            (r["cost_usd"] for r in rows if isinstance(r.get("cost_usd"), str)),
            "no cost data",
        ),
        "errors": sum(1 for r in rows if r["verdict"] == "ERROR"),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--systems", default="splen", help="comma-separated: splen,gpt,claude,gemini")
    ap.add_argument("--label", default="run")
    ap.add_argument("--limit", type=int, default=0, help="first N cases only (smoke test)")
    ap.add_argument("--out", default=None)
    for name, default in DEFAULT_MODELS.items():
        ap.add_argument("--model-%s" % name, default=default)
    args = ap.parse_args()

    if not os.path.isdir(PROMPT_DIR):
        print(
            "prompts/ missing — generate them first:\n"
            "  npx vitest run --config scripts/benchmark/vitest.gen.config.ts",
            file=sys.stderr,
        )
        return 2

    with open(os.path.join(HERE, "taskset.json"), encoding="utf-8") as fh:
        taskset = json.load(fh)
    cases = taskset["cases"]
    core_ids = {c["id"] for c in cases if c["category"] != "memory"}
    pricing = load_pricing()

    systems = [s.strip() for s in args.systems.split(",") if s.strip()]
    unknown = [s for s in systems if s not in ADAPTERS]
    if unknown:
        print("unknown system(s): %s" % ", ".join(unknown), file=sys.stderr)
        return 2

    all_results, summaries = {}, []
    for system in systems:
        model = getattr(args, "model_%s" % system)
        print("\n=== %s (%s) ===" % (system, model))
        rows = run_system(system, model, cases, pricing, args.limit)
        all_results[system] = rows
        summaries.append(summarize(system, model, rows, core_ids))

    out = args.out or os.path.join(HERE, "results-%s.json" % args.label)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(
            {
                "label": args.label,
                "generated": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "taskset_version": taskset["version"],
                "scorer": "scripts/finetune/eval/run_eval.py::score_case (imported)",
                "summaries": summaries,
                "results": all_results,
            },
            fh,
            indent=2,
        )

    print("\n" + "=" * 78)
    print("%-9s %-18s %8s %10s %12s %14s" % ("system", "model", "acc", "median s", "cost/action", "errors"))
    print("-" * 78)
    for s in summaries:
        cost = (
            "$%.6f" % s["cost_per_action_usd"]
            if s["cost_per_action_usd"] is not None
            else (s["cost_note"] or "n/a")[:14]
        )
        acc = "not run" if s["not_run"] else "%d/%d" % (s["core_correct"], s["core_cases"])
        print(
            "%-9s %-18s %8s %10s %12s %14d"
            % (
                s["system"],
                s["model"][:18],
                acc,
                s["latency_median_s"] if s["latency_median_s"] is not None else "n/a",
                cost,
                s["errors"],
            )
        )
    print("=" * 78)
    print("wrote %s" % out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
