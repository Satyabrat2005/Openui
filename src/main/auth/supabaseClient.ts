/**
 * supabaseClient.ts — the single Supabase client used by the main process.
 *
 * Configuration is read from the environment (`SUPABASE_URL`,
 * `SUPABASE_ANON_KEY`), matching how every other secret in OpenUI is provided
 * (see `.env.example`). The client is only ever constructed and used in the
 * Electron MAIN process — the anon key and any session tokens are never exposed
 * to the renderer.
 *
 * Main-process auth specifics: there is no browser `localStorage` or URL to read
 * a session from, and OpenUI manages token persistence (SQLite) and refresh
 * (sessionManager) itself. We therefore disable Supabase's own session
 * persistence, auto-refresh and URL detection.
 *
 * The client is created lazily so a missing env var surfaces as a clear Error
 * the first time auth is used, rather than crashing the main process at import.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let client: SupabaseClient | null = null

/** Build (once) and return the shared Supabase client. */
export function getSupabaseClient(): SupabaseClient {
  if (client) return client

  const url = process.env.SUPABASE_URL
  const anonKey = process.env.SUPABASE_ANON_KEY
  if (!url || !anonKey) {
    throw new Error(
      'Supabase is not configured — set SUPABASE_URL and SUPABASE_ANON_KEY in your .env (see .env.example).'
    )
  }

  client = createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  })
  return client
}

/** True when the required Supabase environment variables are present. */
export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY)
}
