# Telemetry & Privacy Audit — what actually leaves the machine, and when

**Date:** 2026-08-02
**Scope:** `src/main/telemetry/*`, `src/renderer/src/main.tsx`, `src/renderer/src/lib/telemetry.ts`, `src/main/auth/deeplink.ts`, `src/renderer/src/components/ConsentModal.tsx`
**Method:** end-to-end code trace (not marketing copy). This document is the source of truth; privacy-policy wording must match it, not the other way round.

---

## TL;DR

OpenUI has **two** outbound telemetry pipes, both off by default and both gated on the same explicit consent:

| Pipe | Purpose | Destination | Gated on |
|------|---------|-------------|----------|
| PostHog (`posthog-node`) | anonymous product analytics + aggregate crash counter | `POSTHOG_HOST` (default `https://us.i.posthog.com`) | consent GRANTED **and** `POSTHOG_API_KEY` baked in |
| Sentry (`@sentry/electron`) | full crash/error reports | `SENTRY_DSN` | consent GRANTED **and** `SENTRY_DSN` baked in |

**Nothing is transmitted before the user explicitly grants consent** in `ConsentModal`, and **opt-out stops transmission immediately** (same process, not next launch). Two mismatches with the consent copy were found and fixed (see "Fixes applied"). With those fixes, actual behavior matches the "local-first, anonymous analytics" claim.

---

## Consent gating — verified

Trace of the startup and consent lifecycle (`src/main/index.ts`, `telemetry/*`):

- `installCrashReporter()` runs first thing at process start. This only writes a **local** rotating `crash.log` and calls `trackEvent`/`forwardErrorToSentry`, both of which are **no-ops until a client exists** (i.e. until consent). No network egress.
- `initTelemetry()` (PostHog) — creates a client **only** when `getConsentStatus() === GRANTED`. First launch (`UNKNOWN`) and opt-out (`DENIED`) → never constructed. Also no-op when `POSTHOG_API_KEY` is unset.
- `initSentry()` — starts the SDK **only** when consent is GRANTED **and** a `SENTRY_DSN` is present. No DSN → every Sentry function is a silent no-op.
- On first launch `ConsentModal` is shown (status `UNKNOWN`). "Skip" and "Allow" are equally weighted (no dark pattern). "Skip" → `denyConsent()` (permanent no, reversible in Settings); the app is not blocked.
- On **Allow** (`openui:grant-consent`): `grantConsent()` → `enableTelemetryAfterConsent()` + `enableSentryAfterConsent()` bring both pipes online, then `TELEMETRY_OPT_IN` is recorded.
- On **opt-out** from Settings (`openui:set-telemetry-opt-out`): `setTelemetryOptOut(true)` calls `client.shutdown()` and nulls the client; `setSentryOptOut(true)` calls `sdk.close(2000)` and clears `active`. **Both stop immediately** — confirmed against `posthog.ts` / `sentry.ts`, not deferred to a restart.
- On **deny** (`openui:deny-consent`): `denyConsent()` + `shutdownTelemetry()` + `setSentryOptOut(true)`.

Failure-safe default throughout: any unreadable consent state resolves to `UNKNOWN`/"no send" (`getConsentStatus` catch → `UNKNOWN`; `hasConsent` catch → `false`).

---

## What PostHog transmits (analytics + crash counter)

Only after consent. Distinct id is an opaque per-install UUID from `~/userData/.telemetry-id`, replaced after login by the **Supabase user id** (a UUID — pseudonymous, not an email/name).

- **Events** (full list in `telemetry/events.ts`): app lifecycle (`app_started/closed/heartbeat/updated`), `app_crash`, `renderer_error`, auth (started/success/failed/logout — provider + tier + `error_type`, **no email**), chat (`tier`, `model`, `message_length` as an integer, `token_count`, `latency_ms` — **never message text**), model routing, `tool_executed`/`tool_error` (tool **name** + success + timing — **not tool arguments**), `screen_captured` (method only — **no image**), voice (durations only — **no audio**), subscription/checkout, and the local self-improvement counters.
- **Person properties on identify:** `tier` only (see fix #1 — email removed).
- **Free-text fields** that could carry a path: `app_crash.frame` (first stack line), `app_crash.message`, `renderer_error.message`, `renderer_error.source` (script filename). These are now **scrubbed at egress** (see fix #2): OS username in `C:\Users\…` / `/Users/…` / `/home/…` → `[user]`, plus secrets and emails redacted. The remaining string is a de-identified code location, not a user document path.

PostHog never receives: chat/voice content, file contents, screenshots, API keys, or (post-fix) email.

## What Sentry transmits (full crash/error reports)

Only after consent **and** when a `SENTRY_DSN` is configured. `sendDefaultPii: false`, `tracesSampleRate: 0` (errors and native crashes only — no performance traces, no session replay). Every event passes through `scrubEvent`/`beforeBreadcrumb` (`sentry.ts`) before leaving:

- `user`, `request`, `server_name`, and `extra` are **deleted outright**.
- Exception values and every stack-frame `filename`/`abs_path`/`module` are run through `scrubText` (usernames-in-paths, secrets, emails redacted).
- Breadcrumb `message`s are scrubbed and breadcrumb `data` (URLs, args) is **deleted** — this is the most likely place tool arguments or a request body could leak, so it is dropped wholesale rather than scrubbed.

Sentry receives the **shape** of a failure (type, redacted message, redacted stack), not user data.

---

## Fixes applied during this audit

Both were direct contradictions of the `ConsentModal` promises ("anonymous usage data… we NEVER collect personal data / file contents or file paths"):

1. **Email was sent to PostHog on every login.** `deeplink.ts` called `identifyUser(profile.id, { email, tier })`, attaching the user's email as a PostHog person property — not anonymous, and not disclosed. **Fix:** identify with `{ tier }` only; the opaque Supabase user id remains the distinct id. Email is still stored **locally** (`upsertUser`) — it just no longer leaves the machine via telemetry.
2. **Crash/renderer payloads carried unscrubbed file paths.** `app_crash.frame` and `renderer_error.source` embed the user's home-directory path (with OS username) in a packaged build, and PostHog did no scrubbing (unlike Sentry). **Fix:** all string-valued PostHog properties now pass through `scrubText` at the single egress choke point in `posthog.ts` (`scrubProperties`), covered by `posthog.scrub.test.ts`.

## Open wording note (for the privacy policy, not code)

The consent modal says we never collect "file paths." After the scrub, PostHog/Sentry can still contain **de-identified, app-internal code paths** in stack frames (username removed, e.g. `C:\Users\[user]\…\app.asar\index.js`) — standard for crash grouping and not personally identifying. The policy copy should say we never collect **the contents or paths of *your* files/documents**, and that crash reports may include de-identified internal code locations. Flagging rather than silently rewording the product copy.
