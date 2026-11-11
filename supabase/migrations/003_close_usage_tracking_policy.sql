-- 003_close_usage_tracking_policy — remove a policy that let ANYONE write usage.
--
-- 001 created:
--
--   CREATE POLICY "Service role full access" ON usage_tracking FOR ALL USING (true);
--
-- A policy with no `TO <role>` applies to every role, including `anon` and
-- `authenticated`, and policies are OR-ed together. So anyone holding the
-- public anon key — which ships inside every copy of the app — could read every
-- user's row, and insert, change or delete any of them: reset their own daily
-- limit, or fill someone else's.
--
-- The policy was never needed. The chat-proxy Edge Function uses the
-- service-role key, and the service role bypasses row level security entirely.
-- Dropping it leaves exactly what 001 meant: users may read their own row
-- ("Users can read own usage"), and only the server writes.
--
-- Safe to run more than once, and safe on a project where 001 was never run.

DO $$
BEGIN
  IF to_regclass('public.usage_tracking') IS NOT NULL THEN
    DROP POLICY IF EXISTS "Service role full access" ON public.usage_tracking;
  END IF;
END
$$;

-- Check after running: this must return only "Users can read own usage".
--   SELECT policyname, roles, cmd FROM pg_policies WHERE tablename = 'usage_tracking';
