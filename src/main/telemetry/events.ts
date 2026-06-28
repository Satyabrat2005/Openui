// Single source of truth for all analytics events.
// Every trackEvent() call should use a name and property shape defined here.

export const Events = {
  // App lifecycle
  APP_STARTED: 'app_started',
  APP_CLOSED: 'app_closed',
  APP_UPDATED: 'app_updated',             // properties: { previous_version, new_version }

  // Auto-update (electron-updater)
  UPDATE_AVAILABLE: 'update_available',           // properties: { current_version, new_version }
  UPDATE_DOWNLOADED: 'update_downloaded',          // properties: { current_version, new_version }
  UPDATE_DOWNLOAD_STARTED: 'update_download_started', // properties: { current_version }
  UPDATE_INSTALL_RESTART: 'update_install_restart', // properties: { current_version }
  UPDATE_ERROR: 'update_error',                    // properties: { error_type }

  // Auth
  AUTH_LOGIN_STARTED: 'auth_login_started',
  AUTH_LOGIN_SUCCESS: 'auth_login_success', // properties: { provider: 'google', tier }
  AUTH_LOGIN_FAILED: 'auth_login_failed',   // properties: { provider: 'google', error_type }
  AUTH_LOGOUT: 'auth_logout',

  // Chat / Agent
  CHAT_MESSAGE_SENT: 'chat_message_sent',           // properties: { tier, model, message_length, has_voice }
  CHAT_RESPONSE_RECEIVED: 'chat_response_received', // properties: { tier, model, token_count, latency_ms }
  CHAT_ERROR: 'chat_error',                         // properties: { tier, model, error_type }

  // Model routing
  MODEL_ROUTE_SELECTED: 'model_route_selected', // properties: { tier, requested_model, actual_model, reason }
  MODEL_DOWNGRADE: 'model_downgrade',            // properties: { tier, requested_model, downgraded_to }

  // Tools / OS Automation
  TOOL_EXECUTED: 'tool_executed', // properties: { tool_name, tier, success, execution_time_ms }
  TOOL_ERROR: 'tool_error',       // properties: { tool_name, tier, error_type }

  // Vision / Screen
  SCREEN_CAPTURED: 'screen_captured', // properties: { tier, method: 'cloud_vision' | 'local_ocr' }

  // Voice
  VOICE_RECORDING_STARTED: 'voice_recording_started',
  VOICE_RECORDING_COMPLETED: 'voice_recording_completed', // properties: { duration_seconds, tier, transcription_method }
  VOICE_TRANSCRIPTION_FAILED: 'voice_transcription_failed',

  // Subscription
  CHECKOUT_OPENED: 'checkout_opened',       // properties: { target_tier }
  CHECKOUT_COMPLETED: 'checkout_completed', // properties: { tier }
  CHECKOUT_CANCELLED: 'checkout_cancelled',
  PORTAL_OPENED: 'portal_opened',
  TIER_CHANGED: 'tier_changed',             // properties: { from_tier, to_tier }

  // Telemetry itself
  TELEMETRY_OPT_OUT: 'telemetry_opt_out',
  TELEMETRY_OPT_IN: 'telemetry_opt_in',

  // Self-improvement loop (local prompt refinement)
  FEEDBACK_RATED: 'feedback_rated',               // properties: { rating: 1 | 5, source: 'explicit' }
  PROMPT_REFINED: 'prompt_refined',               // properties: { failing_count, clusters, model }
  PROMPT_REFINE_SKIPPED: 'prompt_refine_skipped', // properties: { reason }
} as const

export type EventName = typeof Events[keyof typeof Events]

// Alias kept for modules that reference the upstream EVENTS identifier.
export const EVENTS = Events
