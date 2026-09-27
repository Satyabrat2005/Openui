-- 002_create_splen_downloads — per-user, per-day count of Splen download grants.
--
-- The splen-download Edge Function signs a short-lived URL to Splen's weights
-- in private storage. Each grant is counted here so one account cannot hand the
-- file out at scale (DAILY_GRANT_LIMIT in the function). A resumed download asks
-- for a fresh URL, so the limit leaves room for several resumes.

CREATE TABLE IF NOT EXISTS splen_downloads (
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  grant_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);

ALTER TABLE splen_downloads ENABLE ROW LEVEL SECURITY;

-- Users can read their own count; nobody but the service role can write it.
-- The Edge Function uses the service-role key, which bypasses RLS, so no write
-- policy is needed — and none is granted, deliberately: a policy without a
-- `TO` role applies to every role, including signed-in users.
CREATE POLICY "Users can read own splen downloads" ON splen_downloads
  FOR SELECT USING (auth.uid() = user_id);
