// Kept for editor/tooling discovery. The renderer build resolves Tailwind +
// Autoprefixer inline in electron.vite.config.ts, so this mirrors that setup.
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {}
  }
}
