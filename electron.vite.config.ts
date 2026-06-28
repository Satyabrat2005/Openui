import { resolve } from 'path'
import { defineConfig, loadEnv } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'

// electron-vite builds three separate bundles: main, preload and renderer.
// Tailwind is wired into the renderer's PostCSS pipeline inline so it works
// regardless of where the renderer root sits.
export default defineConfig(({ mode }) => {
  // Load EVERY var from the environment / .env files. The empty-string prefix
  // disables Vite's default `VITE_`-only filter, so non-prefixed values such as
  // SUPABASE_URL are visible here. `loadEnv` merges values from `.env*` files on
  // disk AND from `process.env` (so CI-injected secrets are picked up too).
  const env = loadEnv(mode, process.cwd(), '')

  // The MAIN process has NO access to import.meta.env and, in a packaged app,
  // there is no `.env` on disk — so `process.env.X` is `undefined` at runtime.
  // We must therefore INLINE the build-time config values into the main bundle
  // via `define` (a literal text substitution). Only the keys below are baked;
  // everything else (ANTHROPIC_API_KEY, OLLAMA_HOST, GITHUB_TOKEN, …) stays a
  // real `process.env` lookup so users/devs can still override it at runtime.
  //
  // SECURITY: only PUBLISHABLE values are baked — the Supabase URL + anon key
  // (safe to ship), the Stripe *price* ids (public SKUs) and PostHog ingest
  // config. No secret keys (service-role, Stripe secret, LLM keys) are ever
  // inlined into the client binary.
  const baked: Record<string, string> = {}
  const bake = (key: string, value: string | undefined): void => {
    // Skip empties so we never clobber a runtime `?? default` (e.g. POSTHOG_HOST)
    // with an empty string, and never emit a bare `undefined` token.
    if (value) baked[`process.env.${key}`] = JSON.stringify(value)
  }

  bake('SUPABASE_URL', env.SUPABASE_URL)
  bake('SUPABASE_ANON_KEY', env.SUPABASE_ANON_KEY)
  // The main process reads the non-VITE names; CI only sets the VITE_ copies, so
  // fall back to those to keep the upgrade/checkout flow working.
  bake('STRIPE_PRO_PRICE_ID', env.STRIPE_PRO_PRICE_ID ?? env.VITE_STRIPE_PRO_PRICE_ID)
  bake(
    'STRIPE_ENTERPRISE_PRICE_ID',
    env.STRIPE_ENTERPRISE_PRICE_ID ?? env.VITE_STRIPE_ENTERPRISE_PRICE_ID
  )
  bake('POSTHOG_API_KEY', env.POSTHOG_API_KEY)
  bake('POSTHOG_HOST', env.POSTHOG_HOST)
  bake('VITE_SERVER_URL', env.VITE_SERVER_URL)

  return {
    main: {
      build: {
        rollupOptions: {
          input: { index: resolve(__dirname, 'src/main/index.ts') }
        }
      },
      define: baked
    },
    preload: {
      build: {
        rollupOptions: {
          input: { index: resolve(__dirname, 'src/preload/index.ts') }
        }
      }
    },
    renderer: {
      root: 'src/renderer',
      // The renderer root is `src/renderer`, but the `.env` lives at the project
      // root — point Vite's env loader there so `import.meta.env.VITE_*` resolves.
      envDir: resolve(__dirname),
      envPrefix: ['VITE_'],
      build: {
        rollupOptions: {
          input: { index: resolve(__dirname, 'src/renderer/index.html') }
        }
      },
      plugins: [react()],
      css: {
        postcss: {
          plugins: [tailwindcss(), autoprefixer()]
        }
      }
    }
  }
})
