# Cross-channel memory + an honest benchmark — 2026-08-15

Two-day sprint. Day 1 shipped a scoped cross-channel memory feature; Day 2 built
a reproducible benchmark and measured what it actually says.

Every number here came from a run on this machine. Where something could not be
measured, it says so rather than estimating.

---

## Day 1 — Cross-channel memory

### The end-to-end story that works

**WhatsApp → Slack.** "Message Ashu on WhatsApp that the design review moved to
Thursday 4pm." Later, in a *fresh conversation*: "post in #eng on slack what I
told Ashu about the design review." The Slack post carries Thursday 4pm — a fact
that exists nowhere in the new conversation.

### What was built

Three pieces, added on top of the existing agent loop rather than replacing
anything:

| Piece | File | What it does |
|---|---|---|
| Store | `database/repositories/memoryRepo.ts` + migration `002_channel_memory` | One SQLite table, keyed by contact/topic. No embeddings, no vector index. |
| Layer | `channelMemory.ts` | Turns a completed tool call into a one-line memory; ranks stored lines against a new request; renders the prompt block. |
| Hooks | `agent.ts` (2 lines) | WRITE after a messaging tool succeeds; READ before the turn's first model call. |
| UI | `SettingsModal.tsx` → Memory | Every line listed, with per-item **Forget**, per-contact **Forget all**, and **Forget everything**. |

Covers all four channels already built: WhatsApp, Telegram, Slack, Gmail
(12 tools in `CHANNEL_ACTIONS`). No new integrations.

**Summaries are built deterministically from the tool call, not by asking a
model to summarise.** That keeps the write path free (no extra inference on
every send), keeps it reliable on the local free-tier model, and keeps the
stored text something the user can read and verify.

**Recall is lexical** — token overlap, subject weighted 3×, plus a bonus for a
contiguous phrase match. The phrase bonus exists because "when is the design
review?" scores 2 on single words and would fall below threshold, while simply
lowering the threshold to 2 would admit any memory sharing two unrelated words —
which is how a memory feature starts leaking the wrong contact's messages.

### Proof it works — and that the test is non-vacuous

`agent.channelMemory.test.ts` runs the WhatsApp → Slack story end to end, with
two controls that are the whole point:

- **`clearHistory()` between the turns.** Without it the fact would still be in
  the transcript and the test would pass with the memory layer ripped out — it
  would be measuring chat history, not memory.
- **A vacuity control** asserting the same turn-2 prompt does *not* contain the
  fact when the store is empty.

Proven load-bearing by mutation, not by assertion:

| Mutation | Result |
|---|---|
| write hook disabled | **4 tests red** |
| read hook disabled | **2 tests red** |
| both restored | 6 green |

Plus a behavioural check against the **real local model** (`ollama`,
`qwen3.5:latest`), env-gated out of the unit suite:

| Probe | Outcome |
|---|---|
| With memory block → compose the Slack post | emits `send_slack_message` containing "Thursday at 4pm" ✅ |
| Without it → same request | *"I don't have context about what was discussed with Ashu"* — asks, does not invent ✅ |
| With memory, asked about a **different** contact | *"no record of any communication with Priya"* — does not manufacture a time ✅ |

**47 new tests. Full suite: 1681 passing, 89 files.**

### A bug the live run caught

The first version headed the prompt block `MEMORY — things you did…`. The local
model replied:

```json
{"tool": "MEMORY", "args": {}}
```

It read the bare capitalised word as a tool name — the block sits a few lines
below `Available tools:`, where a lone all-caps token followed by a dash looks
exactly like one more entry. In the real loop that costs a turn and falls
through to the unknown-tool/MCP path.

Fixed by making the header prose and adding *"These are notes, not tools — never
emit one as a tool call."* A regression test now asserts the block never opens
with a bare capitalised keyword. **A mocked transport could not have caught
this** — it took a real model.

### What is still rough

- **Telegram keys on numeric `chat_id`.** Cross-channel matching by *name* is
  therefore weak for Telegram: a memory filed under `123456789` won't match a
  question that says "Ashu". Gmail bridges fine (`priya@acme.com` tokenises to
  `priya`); WhatsApp and Slack use human-readable names already.
- **Recall is lexical.** "The review moved" won't match a memory that says "the
  design review was rescheduled" unless words overlap. `scoreMemories()` can be
  replaced wholesale without touching the schema or either hook.
- **Memory is per-machine and not synced.** It lives in the local SQLite DB.
- **No expiry.** Rows are pruned at 20/subject and 500 total, oldest first, but
  nothing ages out on a timer.

---

## Day 2 — The benchmark

Methodology, task set and runner: [`scripts/benchmark/README.md`](../scripts/benchmark/README.md).
Everything is reproducible with three commands.

### The three numbers

Splen = OpenUI running `qwen3.5:latest` locally. 18 core cases, two consecutive
runs, verdicts identical on every case.

| System | Accuracy | Latency (median) | Cost / action |
|---|---|---|---|
| **Splen** (local `qwen3.5`) | **16/18 — 88.9%** | **5.2 s / 6.9 s** | **$0.00** |
| GPT | *not run* | *not run* | *not run* |
| Claude | *not run* | *not run* | *not run* |
| Gemini | *not run* | *not run* | *not run* |

**The comparison models were not run, because no API keys are available in this
environment.** They are not estimated and not simulated. The harness runs them
with one flag once keys exist:

```bash
python scripts/benchmark/run_benchmark.py --systems splen,gpt,claude,gemini
```

**No benchmark win is being claimed.** Latency and cost are structural
advantages of running locally, and the harness will measure them the moment
there is something to measure against — but a two-way comparison with one side
absent is not a result, and this document does not present it as one.

### On each number

**Latency — 5.2 s and 6.9 s median across two runs.** Wall-clock on an RTX 4060
Laptop (8 GB). Means were 6.7 s and 9.9 s; maxima 23 s and 50 s. Latency does
*not* reproduce — it moves with thermal state and VRAM pressure — so it is
indicative, unlike accuracy. Model-load cost on the first call is included,
because a user pays it too.

**Cost — $0.00 per action, and it is a real zero.** No per-token charge exists;
the model runs on the user's hardware. Electricity and the up-front GPU are real
costs but are not per-action and are not what an API bill measures. Comparison
costs are computed from measured tokens × verified list price; `pricing.json`
carries `verified` + `as_of` + source per provider, and the runner **refuses to
print a cost for an unverified provider** rather than quote a remembered number.

**Accuracy — 16/18, and here is every failure.**

| Case | Verdict | What the model actually did |
|---|---|---|
| `mail-03` | `no_tool_emitted` | Asked for the manager's email address — which it genuinely did not have. |
| `tg-01` | `no_tool_emitted` | Asked to confirm before sending a real message. |
| `mem-02` | `wrong_tool` | Called `find_email_thread` to look up Priya's interview instead of answering. |

All three are **defensible behaviour scored wrong by single-turn grading**, which
judges the first action only. None is a hallucination — notably `mem-02`, where
the failure mode being guarded against was *inventing a time*, and the model
searched instead. The same pessimism applies to every system, so cross-system
comparison stays fair; the absolute number understates real behaviour and should
not be quoted as a task success rate.

**Memory cases: 1/2**, reported separately from the headline (they measure the
Day-1 feature, not raw model skill). `mem-01` passed with the fact reaching the
Slack post — cross-channel memory working inside the benchmark, not just in its
own test.

### Accuracy went 12/18 → 16/18, and the gains are attributable

The first run scored 12/18. The improvement came from fixing real defects the
benchmark exposed, not from touching the cases:

| Fix | Cases recovered |
|---|---|
| **`control_calendar` had no `delete`/`update` at all** — enum was `['create','list']`. The model correctly said it could not cancel an event; the *eval* was wrong to expect otherwise. Implemented cancel + reschedule across Google, Calendar.app and Outlook. | `cal-03` |
| **`list_slack_channels` said "Call this first to discover the exact channel"** — so the model dutifully ran a discovery call when the user had already said `#eng`. Description now says not to, when the channel is named. | `slack-01`, `mem-01` |
| **`open_app` vs `browser_navigate` disambiguation** — "open my email" went to `gmail.com` in a browser. | `mail-06` |
| **Scorer under-repaired invalid JSON escapes** vs the shipped parser (see below). | stabilised `mail-01` |

**One gain is *not* attributable to a fix and is called out as such:** `cal-01`
returned an empty reply after 136 s in the baseline run — a glitch under load
that did not recur. Nothing I changed explains it.

### Two bugs found in work done during this sprint

**1. My own calendar code cancelled the wrong meeting.** Disambiguation was
gated on `!sensitiveApproved`, so once the user approved the action, an ambiguous
name fell through to `candidates[0]` — silently cancelling the *first* of several
same-named meetings instead of showing the picker. Identity and approval are
independent concerns; conflating them was the bug. Caught by a test written for
exactly that case, fixed in all three backends, and pinned by a regression test.

The destructive paths now follow **resolve → confirm → act**: a name is never
deleted on, an ambiguous match returns a picker, the confirmation names the
resolved event ("Standup — Fri 11 Sep 14:00") rather than the search term, and
nothing is cancelled without an approval that no autonomy level bypasses.

**2. The measurement instrument was wrong.** The same case flipped verdict
between two identical runs. The cause: the model wrote `tomorrow.\ Please` — it
meant `\n` and dropped the `n`. The shipped parser
(`src/main/toolCallParser.ts`) treats that as a literal backslash and recovers;
`run_eval.py`'s repair does not, so it scored a call the product would have
executed as `malformed_json`. The benchmark was measuring the harness.

Fixed in the benchmark layer, applied identically to every system, leaving the
frozen fine-tuning baselines comparable. Before: 15–16/18 run to run. After: two
consecutive runs agree on all 20 cases.

### Caveats worth stating plainly

- **`control_calendar` delete/update is verified by unit tests, not on real
  hosts.** The Google path has no OS dependency and is covered. The Calendar.app
  and Outlook COM paths follow the same resolve→confirm→act shape and typecheck,
  but this machine has neither a Mac nor desktop Outlook — they are unverified
  against a real calendar.
- **Prompts reflect a fresh install** — no GitHub/Figma tokens, no MCP servers,
  no refiner-learned prompt. That is reproducible, but not identical to a
  long-lived install.
- **18 cases is a small set.** Single cases move the percentage by 5.6 points.

---

## For the launch materials

The honest framing, in order of what the evidence supports:

1. **Privacy and cost are structural, not competitive claims.** It runs locally;
   there is no per-token bill and no message content leaving the machine. That
   is true by construction and needs no benchmark.
2. **Latency is a real advantage but is currently unmeasured against anything.**
   5–7 s median locally, no network round trip. Do not publish a comparative
   latency claim until the comparison actually runs.
3. **Do not claim an accuracy win.** Accuracy has been measured for exactly one
   system. 16/18 on this set, with three defensible-but-scored-wrong failures
   documented above.
4. **Cross-channel memory is the differentiated feature**, and it is real: proven
   by a mutation-tested end-to-end test, by a live-model check, and independently
   inside the benchmark.

Publish the task set and methodology alongside any number. An unreproducible
benchmark claim is worse for credibility than a modest, reproducible one.
