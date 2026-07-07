/**
 * Single-flight queue for local Ollama inference.
 *
 * This build targets an 8 GB VRAM card, which can only hold one local model's
 * working set at a time — issuing two generations concurrently risks a CUDA OOM
 * or silent thrashing into shared system RAM. So every local Ollama generation
 * (interactive/offline chat, the autonomous coding fallback, and the
 * self-improvement refiner) funnels through here and runs strictly one at a
 * time, in submission order.
 *
 * NOTE: OpenUI runs entirely on local Ollama, and this card holds one model at a
 * time — so even features that *look* concurrent (e.g. parallel subagents) funnel
 * through here and run one after another rather than fighting over VRAM. Do NOT
 * add a "run two local models at once" path; it does not fit the hardware.
 */

// The tail of the queue. Each new call chains onto it, so at most one `fn` is
// ever in flight. Predecessor results/rejections are swallowed so one failed
// call can never poison the queue for the calls waiting behind it.
let tail: Promise<unknown> = Promise.resolve()

export function withOllamaLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(() => fn(), () => fn())
  // Keep the tail alive (and its rejections handled) so the next caller waits
  // for this one to finish regardless of outcome.
  tail = run.then(
    () => undefined,
    () => undefined
  )
  return run
}
