-- Remove abandoned anonymous-auth accounts after their 30-day trial period.
-- Deleting auth.users cascades to owned_pokemon, teams, team_members, and opponent_notes.
CREATE OR REPLACE FUNCTION public.delete_stale_anonymous_users()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = auth, public
AS $$
BEGIN
  DELETE FROM auth.users
  WHERE is_anonymous = true
    AND created_at < now() - interval '30 days';
END;
$$;

-- pg_cron is available on hosted projects but not every local Supabase image. Check
-- availability before attempting CREATE EXTENSION so this migration remains portable.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_cron';
  END IF;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'delete-stale-anonymous-users') THEN
      PERFORM cron.schedule(
        'delete-stale-anonymous-users',
        '0 3 * * *',
        'SELECT public.delete_stale_anonymous_users()'
      );
    END IF;
  END IF;
END;
$$;

-- PostgREST は public スキーマの関数を RPC として公開するため、匿名/認証ロールからの
-- 呼び出しを禁止し、cron とサービスロールだけが実行できるようにする。
REVOKE EXECUTE ON FUNCTION public.delete_stale_anonymous_users() FROM PUBLIC, anon, authenticated;
