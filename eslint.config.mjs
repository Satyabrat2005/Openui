// ESLint flat config. Deliberately scoped to correctness and dead-code rules —
// formatting is left alone (no Prettier) so this can be adopted without a
// repo-wide reformat. Type-aware linting is enabled only for src/, which is the
// TypeScript the app actually ships.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import react from 'eslint-plugin-react'
import globals from 'globals'

export default tseslint.config(
  {
    // Build output, generated assets and vendored code are never linted.
    ignores: ['out/**', 'dist/**', 'node_modules/**', 'resources/**', 'scripts/**', 'supabase/**']
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      // The codebase uses `catch (err)` and re-throws or logs; unused args
      // prefixed with _ are an established convention here (see modelForTier).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ],
      // `any` is already absent from this tree; keep it that way, but as a
      // warning so it never blocks a legitimate escape hatch in a hurry.
      '@typescript-eslint/no-explicit-any': 'warn'
    }
  },

  // Main + preload are Node/Electron; renderer is the browser.
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // Deliberate: the main process lazy-`require()`s native and heavy modules
      // (better-sqlite3, tesseract, screenshot-desktop, googleapis, …) inside the
      // function that needs them, so a missing optional binary degrades to a
      // caught error instead of crashing startup. Static imports would hoist that
      // cost — and that failure — to app launch. These sites were already
      // annotated for this rule under its pre-v8 name (`no-var-requires`).
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { react, 'react-hooks': reactHooks },
    settings: { react: { version: 'detect' } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The renderer is on the automatic JSX runtime — React need not be in scope.
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off'
    }
  },

  // Vitest globals, and test files legitimately use loose typing for mocks.
  {
    files: ['**/*.test.{ts,tsx}'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off'
    }
  },

  // Root build-tool configs are CommonJS scripts, not app source.
  {
    files: ['*.config.js', '*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node }
    }
  }
)
