import { app } from 'electron'
import { config } from 'dotenv'

/**
 * Local dev only: populate `process.env` from a `.env` file in the project root.
 *
 * electron.vite.config.ts already bakes SUPABASE_URL/ANON_KEY, STRIPE_*_PRICE_ID,
 * POSTHOG_API_KEY/HOST, SENTRY_DSN, VITE_SERVER_URL and OPENUI_MAC_SIGNED into
 * literal strings at build time via Rollup `define`, so those work with or
 * without this file. Everything else read as a bare `process.env.X` in main
 * (OLLAMA_*, GITHUB_TOKEN, FIGMA_TOKEN, GOOGLE_OAUTH_*, WHISPER_CPP_PATH,
 * OPENUI_WORKSPACE, …) is a real runtime lookup and was never populated from
 * `.env` — nothing called dotenv.config() anywhere in the app. This is that call.
 *
 * Packaged installs ship with no `.env` beside the binary, so this is gated on
 * `!app.isPackaged` rather than relying on the file simply not existing — a
 * stray `.env` sitting in whatever directory a packaged build happens to be
 * launched from should never silently change production behavior.
 *
 * MUST stay the very first import in index.ts: ES module evaluation runs each
 * import's entire dependency subtree before the next sibling import starts, and
 * a couple of modules (models.ts, finetune/pipeline.ts) capture
 * `process.env.OLLAMA_*` into a module-level constant at import time — so this
 * has to finish before those modules are ever reached.
 */
if (!app.isPackaged) {
  config()
}
