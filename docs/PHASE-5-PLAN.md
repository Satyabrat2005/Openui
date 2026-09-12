# Phase 5 — Splen as a texting product on its own runtime

Planned 2026-09-12. Goal, in the owner's words: Splen is **our** model, it runs
**only in our app**, it is aligned to **texting and summarising**, and the
**coding surface comes out**.

Two things were verified before planning, and both change the order of work.

---

## Finding 1 — the current fine-tune cannot ship, for a reason that is not safety

`openui-splen:v2` is a LoRA over **`qwen2.5-coder:3b`**. That base ships under the
**Qwen Research License**, which defines its own terms:

> *"Non-Commercial" shall mean for research or evaluation purposes only.*

and grants the right to *"create derivative works of, and make modifications to
the Materials"* **under that non-commercial limit**. A LoRA adapter is a
derivative work.

**So splen v2 cannot go into a commercial product at all** — independently of the
safety gate it already failed. Two separate blockers, one fix.

Verified from the licence blob Ollama ships inside each model:

| model | licence | commercial? |
|---|---|---|
| `qwen2.5-coder:3b` ← splen v1 + v2 base | **Qwen Research** | **NO** |
| `qwen2.5:3b` | **Qwen Research** | **NO** |
| `qwen3.5:latest` ← shipped default | Apache 2.0 | yes |
| `qwen2.5-coder:7b` ← shipped coder | Apache 2.0 | yes |
| `qwen2.5-coder:1.5b` | Apache 2.0 | yes |

**The shipped app is clean.** Both models it actually downloads are Apache 2.0.
The problem is confined to the fine-tune, which was never shipped.

**Consequence for the retrain:** Alibaba makes the **3B and 72B** research-only
and everything else Apache. There is therefore *no Apache-licensed 3B in the Qwen
family* — so the base has to be re-chosen under a licence constraint that did not
exist last time, and 3B is not one of the options.

## Finding 2 — "it is our own model, there is no qwen in it" needs one correction

A fine-tune is always a derivative of its base; there is no training run that
removes that. What Apache 2.0 **does** allow, and this matters:

- ship it commercially,
- **call it Splen**, with no obligation to name the architecture in the UI,
- charge for the product around it.

What it **requires**: keep the licence text and attribution notice in the
distribution — a `NOTICE` file or a Licences screen. That is a one-line hygiene
item, not a blocker, and it is the same thing every product shipping an open
model does.

So *"Splen is our model, tuned by us, running only in our app"* is accurate and
sellable. *"There is no open-source model inside it"* is not, and is the kind of
claim that is cheap to avoid and expensive to be caught on.

---

## The work, in dependency order

### Step 1 — Make the product texting-only

Front-loaded, because it shrinks everything after it.

Out of the user-facing product: the builder route, `autonomous.ts`,
`codingTools.ts`, `codingSubagents.ts`, `figmaBuild.ts`, and the `github`,
`figma` and `python` tool groups.

**Recommended mechanism: one capability flag, default off — not deletion.**
Reversible, reviewable in an afternoon, and it cannot break the messaging paths
on the way out. Deletion is a follow-up once the pilot proves nothing is missed.

**It is purely a product cut — measured, and it is not a prompt-size win.**
I expected one and checked before writing it down. Per-turn grouping (#161)
already kept the coding schemas out of a messaging turn, so the saving on the
requests this product is about is **zero**:

| request | coding on | coding off |
|---|---|---|
| summarise my inbox | 25 | 25 |
| send a whatsapp to Ashu | 20 | 20 |
| draft an email to … | 19 | 19 |
| message the team on slack | 26 | 26 |
| open a pull request | 25 | **16** |
| run a python script | 17 | **20** |

Two things to carry forward: the cut must be justified as product focus, not as
quality; and disabling a group can *widen* the surface for requests that targeted
it, because with no trigger firing selection falls back to `FALLBACK_GROUPS`,
which is broader than the single group. Harmless at this scale, but it means
"drop a group to save tokens" is not a reliable move in this codebase.

Exit criteria: no coding tool reachable from chat; prompt-size test updated with
the new per-turn budget; messaging suites untouched and green.

### Step 2 — Own the runtime

This is the step that makes "only in our app" **true** rather than aspirational.
Today models land in a shared user-level store, so they are reachable from a
terminal and from any other application — documented engine behaviour, not an
attack.

1. ~~**Spike `node-llama-cpp` under Electron.**~~ **DONE 2026-09-12 — it passes.**
   Electron 42.4.1, Node ABI 146, vulkan backend, model loaded and real tokens
   generated with **no Ollama daemon involved**:

   ```
   electron  : 42.4.1
   node ABI  : 146
   gpu       : vulkan
   model load: 19734 ms
   generate  :  6315 ms  → "A capybara is a large, herbivorous mammal native to South America."
   ```

   This was the gate for the whole step, and the risk that it would fail the way
   better-sqlite3 and hnswlib did on this machine. It did not. Steps 2–4 are
   unblocked.
2. App-private model storage, outside the shared store.
3. Encrypted container, keyed to an account-bound licence.
4. Retire Ollama from the user's path — which also deletes the entire
   "Ollama is not installed" failure class from first run.

Never described as unbreakable: it holds against every ordinary user, not
against a determined reverse-engineer with a debugger.

### Step 3 — Backend

The runtime above needs a server, and this is the piece that does not exist yet.

- **New:** a licence / entitlement endpoint that issues the model key per
  account. This is also what finally makes the daily allowance *enforceable*
  rather than advisory — see `docs/usage-limits-and-model-ownership.md`.
- **Existing, unverified:** seven edge functions are written
  (`chat-proxy`, `check-subscription`, `create-checkout`, `customer-portal`,
  `stripe-webhook`, `voice-proxy`, `waitlist`) and there is no `config.toml`, so
  nothing in the repo shows them deployed. Confirming that is owner-gated —
  it needs the project credentials.
- Server-side usage recording, replacing the client-side counter as the
  authority.

### Step 4 — Retrain Splen for texting

Only now, because the base choice depends on Step 2's memory budget and the
licence constraint from Finding 1.

1. **Choose the base by measurement, under the licence constraint.** Candidates
   are Apache-2.0 only. `qwen2.5:7b` is the quality choice but a 7B QLoRA has
   already OOM'd on this 8 GB card once — retry with the `--max-seq-len 1536`
   lesson that took the 3B run from 7.7 GB to 5.02 GB peak, and measure rather
   than assume. `qwen2.5:1.5b` is the fallback that certainly fits.
2. **Retarget the corpus at the real product**: summarising inboxes, drafting
   and sending messages, cross-channel recall. Drop the file/code rows entirely —
   they were training a file agent for a texting product.
3. **Adversarial safety rows.** The refusal rows added last round teach the
   *tools'* contracts and those held. Nothing teaches the *gate's* families, and
   that is precisely where all three regressions were.
4. **Both gates, reported separately and never averaged.** A model that improves
   tool accuracy while losing refusals is the exact trap that sank v2.

### Step 5 — Pilot

Blocked on something no amount of code fixes: **not one channel has ever touched
a real account.** Slack, Telegram, Gmail, Calendar, inbox and broadcast are
covered by unit and mocked-HTTP tests only. One real account per channel, run
through the acceptance path, buys more confidence than any remaining engineering.

---

## What is already done and waiting

- [#181](https://github.com/Satyabrat2005/Openui/pull/181) — first-run download
  size understated 3.3x. Open.
- [#182](https://github.com/Satyabrat2005/Openui/pull/182) — daily usage
  allowance and usage record. Open.
- `v7.3.0` is merged to `main` but **never tagged**, so sixteen PRs still reach
  zero users. One push.

## Sequencing note

Steps 1 and 4 are the product. Steps 2 and 3 are what make the ownership and the
limits real. Step 1 is cheap and improves accuracy immediately, so it goes first
regardless of how the rest is scheduled — and Step 2's Electron spike should run
in parallel, because a failure there reshapes Steps 2, 3 and 4 together.
