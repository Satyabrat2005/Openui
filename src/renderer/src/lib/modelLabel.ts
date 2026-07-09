/**
 * modelLabel.ts — turn a raw model id into a concise, HONEST display label.
 *
 * The backend pushes the exact model id it is running for a turn (e.g. via
 * `openui:chat:model`). The UI must show that real model — never a fabricated
 * name — so this shared prettifier is the single place that formats it, used by
 * both the task-board tag and the Local-AI status footer.
 *
 *   "llama3:8b"     → "Llama 3 8B"
 *   "qwen3.5:9b"    → "Qwen 3.5 9B"
 *   "qwen2.5:latest"→ "Qwen 2.5"   (a "latest" tag carries no size, so drop it)
 */
export function labelForModel(model: string): string {
  const base = model.split(':')[0].replace(/[-_]/g, ' ')
  const tag = model.includes(':') ? model.split(':')[1] : ''
  const size = tag && tag !== 'latest' ? ` ${tag.toUpperCase()}` : ''
  return base.replace(/([a-z])(\d)/gi, '$1 $2').replace(/\b\w/g, (c) => c.toUpperCase()) + size
}
