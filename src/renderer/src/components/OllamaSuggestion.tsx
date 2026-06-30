/**
 * OllamaSuggestion — intentionally disabled.
 *
 * OpenUI is cloud-first: a silent guest session means the assistant works the
 * instant the app launches, with no local model to install. We therefore never
 * advertise Ollama as something the user should download — doing so made setup
 * look mandatory and confused testers. Local AI remains supported purely as an
 * opt-in power-user path (the app auto-detects a running Ollama and routes to it
 * — see agent.ts), but it is never surfaced as a prompt here.
 *
 * Kept as a no-op component so its mount point in AssistantPopup is stable; the
 * previous install-prompt UI lives in git history if we ever want a settings
 * toggle for it.
 */
export default function OllamaSuggestion(): JSX.Element | null {
  return null
}
