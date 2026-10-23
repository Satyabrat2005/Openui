/**
 * Which tools need a paid tier, kept apart from tools.ts so the prompt builder
 * (agent.ts) can ask "is this tool usable on this plan?" without importing the
 * whole tool registry.
 *
 * 'read_screen_cloud_vision' is a logical name used for gating documentation;
 * the actual branching (OCR vs Vision) is handled inside read_screen() based
 * on context.tier.
 */
export type Tier = 'free' | 'pro' | 'enterprise'

export const TIER_TOOL_REQUIREMENTS: Partial<Record<string, Tier>> = {
  read_screen_cloud_vision: 'pro',
  // The visual fallback loop reasons over screenshots with cloud vision (same
  // path as read_screen's pro branch), so it requires a paid tier.
  computer_use: 'pro',
  // Same vision loop as computer_use, driven inside the automation browser.
  browser_vision_act: 'pro'
}

export const TIER_ORDER: Tier[] = ['free', 'pro', 'enterprise']

/** Can a caller on `tier` run `tool`? Tools with no requirement always can. */
export function toolAllowedForTier(tool: string, tier: Tier): boolean {
  const required = TIER_TOOL_REQUIREMENTS[tool]
  return !required || TIER_ORDER.indexOf(tier) >= TIER_ORDER.indexOf(required)
}
