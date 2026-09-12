/**
 * ts-resolve-hook.mjs — let plain Node import the app's own TypeScript.
 *
 * The app is bundled by electron-vite, so its source uses extensionless
 * relative imports (`import { x } from './googleCalendar'`). A bundler resolves
 * those; Node's ESM loader does not, and fails with ERR_MODULE_NOT_FOUND naming
 * a path that visibly exists — which reads like a missing file rather than a
 * missing extension.
 *
 * This hook appends the extension Node needs so `--experimental-strip-types`
 * can do the rest. It is deliberately the smallest possible shim:
 *
 *   - relative specifiers only. A bare specifier is a real package and must
 *     keep resolving through node_modules, or a broken dependency would be
 *     silently papered over by this file.
 *   - `.ts` first, then `/index.ts`, matching how the bundler resolves.
 *   - anything that already has an extension is left completely alone.
 *
 * Used only by the acceptance harness. Nothing the app ships loads this.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
    const parent = context.parentURL ? fileURLToPath(new URL('.', context.parentURL)) : process.cwd()
    for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
      const abs = fileURLToPath(pathToFileURL(parent + candidate.replace(/^\.\//, '')))
      const resolved = new URL(candidate, context.parentURL)
      if (existsSync(fileURLToPath(resolved)) || existsSync(abs)) {
        return nextResolve(candidate, context)
      }
    }
  }
  return nextResolve(specifier, context)
}
