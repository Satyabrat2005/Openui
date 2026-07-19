// Kept for editor/tooling discovery. The renderer build resolves Autoprefixer
// inline in electron.vite.config.ts, so this mirrors that setup. Tailwind was
// removed — it was configured but no utility class was ever used; see the note
// at the top of src/renderer/src/index.css.
module.exports = {
  plugins: {
    autoprefixer: {}
  }
}
