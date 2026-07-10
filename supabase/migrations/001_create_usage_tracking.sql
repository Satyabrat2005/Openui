-- 001_create_usage_tracking — per-user, per-day cloud message counter.
--
-- The chat-proxy Edge Function reads/writes this table to enforce each tier's
-- daily message limit (Free = 5/day on OUR API keys, see chat-proxy's
-- DAILY_LIMIT map and src/main/stripe/pricing.ts's TIERS.free.dailyMessageLimit).
-- One row per user per day; the count resets naturally because a new day
-- yields a new (user_id, date) key.

CREATE TABLE IF NOT EXISTS usage_tracking (
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  message_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);

-- RLS policies
ALTER TABLE usage_tracking ENABLE ROW LEVEL SECURITY;

-- Users can read their own usage (e.g. to show a counter); they cannot write it.
CREATE POLICY "Users can read own usage" ON usage_tracking
  FOR SELECT USING (auth.uid() = user_id);

-- The Edge Function uses the service-role key, which bypasses RLS entirely; this
-- explicit policy documents that the service role has full access for writes.
CREATE POLICY "Service role full access" ON usage_tracking
  FOR ALL USING (true);
