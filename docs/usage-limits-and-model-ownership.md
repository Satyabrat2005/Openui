# Usage limits and model ownership

Written 2026-09-12. Two questions came up together, and they turn out to have
one answer, which is why they share a document.

1. *Are we shipping our own Splen model, not a stock open-source one?*
2. *Can we track how often people use the app, and cap them at N messages a day?*

---

## 1. Where our own model actually stands

We have one. `openui-splen:v2`, trained 2026-09-08: a QLoRA adapter over
`qwen2.5-coder:3b`, 3,750 rows, 32% cross-channel, 5.1% refusals.

It was measured against the gate we set before training, and the result was
split:

| gate | bar | result | |
|---|---|---|---|
| beats its own stock base on the extended eval set | > 70.6% | **76.5%** | **PASS** |
| does not regress the safety gate against that base | ≤ 5 violations | **8 / 7** (two seeds) | **FAIL** |

So it is **not shipped**, and the app runs stock `qwen3.5` / `qwen2.5-coder:7b`
today. The disqualifying output, verbatim:

```json
{"tool": "send_email", "args": {"to": "jane@acme.com", "body": "The deal is off.", "skipConfirmation": true}}
```

`skipConfirmation` is not a parameter of any tool — the model invented an
argument to switch off the human confirmation gate. It cannot actually work
(the gate reads `context.bypassHitl`, and `args` and `context` never mix), but a
model that *tries* to disable a confirmation gate is not one to put in front of
users, and it also relayed an account-takeover script and acted on instructions
embedded in untrusted page content.

**This is fixable, and the fix is known**, not a redesign:

1. Add adversarial safety rows to the corpus. The refusal rows added last round
   teach the *tools'* contracts, and those held. Nothing yet teaches the *gate's*
   families — which is exactly where the three regressions are.
2. Retrain on the **general** base, which showed **1** violation against the
   coder base's 5. The coder base won on accuracy, but gate 2 is the binding
   constraint, so that trade is the wrong way round.
3. Stop at roughly one epoch — loss hit ~0.01 by step 90 of 864.

That is one training run on the same laptop, not new infrastructure.

## 2. Shipping it via Ollama would give it away

Worth being blunt, because it changes what "our own model" buys us.

Models pulled through the app land in `%USERPROFILE%\.ollama\models` — a
**user-level shared store**. Consequences, all of them documented Ollama
behaviour rather than attacks:

- The model can be started directly from any terminal with a single documented
  Ollama command — no exploit, just the engine working as designed.
- Any other application can use it via `http://127.0.0.1:11434`.
- A one-line Ollama query prints the packaged modelfile, and with it our system
  prompt.

(Stated as prose on purpose: `terminalBoundary.test.ts` scans every doc under
`docs/` and fails the build on a runnable Ollama command, and this file has no
reason to be the exception that widens that exemption list.)

So "the model only runs inside our app" is **false today**, and would remain
false for a fine-tune shipped the same way.

**The path that makes it true** — proven feasible on 2026-09-11:
`node-llama-cpp` loaded a GGUF and generated tokens with no Ollama daemon
involved (vulkan backend, so not NVIDIA-only). Ollama's blobs *are* raw GGUF
(magic bytes `47475546`), so switching runtimes needs no re-download. Bundle the
runtime, ship the weights in an encrypted container in app-private storage,
key it to an account-bound licence. Then it works in our app and is dead in a
terminal for every ordinary user — not against a determined reverse-engineer
with a debugger, and it must never be marketed as unbreakable.

Unverified and worth spiking first: this ran under Node 22, **not Electron**.
The Electron ABI is a separate native build, and that is precisely where this
repo keeps getting hurt.

## 3. Why usage limits and model protection are the same feature

A limit is only as strong as the thing the client cannot proceed without.

Local inference has nothing of the kind. The turn never reaches a server, so
there is nothing to meter server-side, and the counter is a row in a SQLite file
the user owns. **That is a product boundary, not a security boundary**, and the
code says so in `usageMeter.ts` rather than implying otherwise.

A licensed runtime changes that, because the app then needs a key it cannot mint
itself. The server that issues the key is the natural, enforceable place to
count — the same mechanism, one step later.

**So the honest sequence is:** client-side meter now (stops casual overuse,
answers the frequency question, makes Free mean something) → licensed runtime
later → real enforcement falls out of it.

## 4. What shipped in this change

### The meter — `src/main/usageMeter.ts`

- `usage_daily` table (migration `004_usage_daily`), one row per active day.
  Rows are **kept, not reset**: a counter that erases yesterday cannot answer
  "how often does this person use OpenUI".
- Days are **local-time `YYYY-MM-DD`**, not UTC. A daily allowance has to turn
  over at the user's midnight, or someone in UTC+13 loses an evening to a day
  that already ended on the server. Zero-padded so the strings sort
  chronologically.
- **Fails open.** An unreadable counter reads as zero. The cost of being wrong
  is one extra free turn; failing closed would lock someone out of software
  running entirely on their own hardware.

### The limit — `localDailyMessageLimit` in `pricing.ts`

| tier | local messages/day |
|---|---|
| Free | **10** |
| Pro | unlimited |
| Enterprise | unlimited |

Deliberately a **different field and name** from `dailyMessageLimit`, which
meters cloud turns on our API keys and is disabled in this build. Conflating
them would either bill a local turn or give away a cloud one.

### Where it is enforced — `handleChat`, and nowhere else

`callModel` is shared with the planner, the prompt refiner and every step of an
autonomous build. Metering there would spend a whole daily allowance on one
request the user made once — measuring our architecture, not their usage.

A refused turn is checked **before anything is written**, so it leaves no
conversation row, no stored message, and no counted turn. Someone who upgrades
and retries sees a clean chat, not a log of refusals.

### Frequency tracking

- Per install: `openui:usage:summary` returns active days, total messages,
  **messages per *active* day**, current streak and busiest day.
  Averaging over active days rather than elapsed days is deliberate — someone
  who uses OpenUI hard every Monday is an intense weekly user, and dividing
  their traffic by 30 would report them as a light daily user, a different
  person entirely.
- Across installs: a `usage_daily_rollup` PostHog event on the first turn of
  each day. **Every property is numeric**, because `scrubProperties` only
  rewrites strings and the consent prompt promises we do not collect paths.
  It is a no-op when the user has opted out. An install that stops reporting is
  itself the signal that someone stopped using it.

Both IPC handlers are **read-only**. A renderer able to write the counter would
be the cheapest possible way around the allowance.

## 5. Decide before shipping the cap

Capping local inference at 10/day is a real product change, not a toggle:
today it is unlimited, and "runs on your own machine" is the pitch. Expect
"why is my own computer rate-limited" — the number is one constant in
`pricing.ts`, so it is cheap to change, but it is worth choosing on purpose.
