import { getDb } from './init'

export function applySchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT,
      display_name TEXT,
      avatar_url TEXT,
      tier TEXT DEFAULT 'free',
      stripe_customer_id TEXT,
      auth_token TEXT,
      refresh_token TEXT,
      token_expires_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      title TEXT DEFAULT 'New Chat',
      model_used TEXT,
      tier_at_time TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT CHECK(role IN ('user','assistant','system','tool')),
      content TEXT,
      tool_calls TEXT,
      tool_results TEXT,
      model TEXT,
      token_count INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS tool_executions (
      id TEXT PRIMARY KEY,
      message_id TEXT REFERENCES messages(id),
      tool_name TEXT,
      tool_args TEXT,
      result TEXT,
      status TEXT CHECK(status IN ('pending','success','error')),
      execution_time_ms INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS subscription_cache (
      user_id TEXT PRIMARY KEY REFERENCES users(id),
      tier TEXT,
      stripe_status TEXT,
      current_period_end INTEGER,
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS voice_usage (
      user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      seconds_used INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, date)
    );

    -- Self-improvement loop: one row per completed assistant turn, scored by an
    -- implicit signal derived from the user's NEXT message ("wrong"/"try again"
    -- → 1, "perfect"/"thanks" → 5, otherwise 3) plus an optional explicit
    -- thumbs up/down. The weekly prompt refiner reads the low-rated rows to
    -- improve the system prompt. See promptRefiner.ts.
    CREATE TABLE IF NOT EXISTS conversation_feedback (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      user_message TEXT,
      assistant_response TEXT,
      implicit_rating INTEGER DEFAULT 3,
      explicit_rating INTEGER,
      timestamp INTEGER DEFAULT (strftime('%s','now'))
    );

    -- Central training store: one row per completed assistant turn, capturing the
    -- FULL trajectory (not just the final answer). training_steps holds the
    -- step-by-step reasoning + tool execution ("do task 1 by 1, reasoning to
    -- itself"). Rows are scored by the same implicit/explicit signal as
    -- conversation_feedback and exported as a fine-tuning-ready JSONL dataset;
    -- the best trajectories are also re-injected as few-shot exemplars so the
    -- free-tier model imitates its own past successes. See trainingStore.ts.
    CREATE TABLE IF NOT EXISTS training_examples (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      user_id TEXT,
      instruction TEXT NOT NULL,
      final_response TEXT,
      step_count INTEGER DEFAULT 0,
      tool_sequence TEXT,
      outcome TEXT CHECK(outcome IN ('success','partial','error','unknown')) DEFAULT 'unknown',
      quality_score INTEGER DEFAULT 3,
      model TEXT,
      tier TEXT,
      duration_ms INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS training_steps (
      id TEXT PRIMARY KEY,
      example_id TEXT REFERENCES training_examples(id) ON DELETE CASCADE,
      step_index INTEGER NOT NULL,
      reasoning TEXT,
      tool_name TEXT,
      tool_args TEXT,
      tool_result TEXT,
      status TEXT CHECK(status IN ('success','error')),
      duration_ms INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_training_examples_quality ON training_examples(quality_score, outcome);
    CREATE INDEX IF NOT EXISTS idx_training_examples_created ON training_examples(created_at);
    CREATE INDEX IF NOT EXISTS idx_training_examples_conversation ON training_examples(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_training_steps_example ON training_steps(example_id, step_index);

    CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_tool_executions_message_id ON tool_executions(message_id);
    CREATE INDEX IF NOT EXISTS idx_settings_key ON settings(key);
    CREATE INDEX IF NOT EXISTS idx_feedback_timestamp ON conversation_feedback(timestamp);
    CREATE INDEX IF NOT EXISTS idx_feedback_conversation ON conversation_feedback(conversation_id);
  `)
}
