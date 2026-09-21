-- broker_accounts lockdown -- run once in the Supabase SQL editor (test on a
-- staging project or off-hours first).
--
-- Problem: the "select own broker account" RLS policy lets the logged-in
-- browser read its own row, INCLUDING ibkr_flex_token and every LLM API key
-- in plaintext. Any script that ever runs on the site's origin (an XSS bug, a
-- compromised CDN script, a browser extension) could read them with the
-- user's own session.
--
-- Fix: the browser can still INSERT/UPDATE its row (to save a key) but can no
-- longer SELECT the secret columns. The Settings page reads a small view that
-- exposes only non-secret columns plus has_<secret> booleans. The Render
-- service uses the service_role key, which bypasses all of this, so
-- daily_sync.py's get_broker_accounts() keeps working unchanged.
--
-- ORDER MATTERS: deploy the updated settings.html first (it falls back to the
-- old select("*") if the view is missing), then run this file.

-- 0. Make sure every column the Settings page writes actually exists. Older
--    broker_accounts tables were created before the AI-provider card was added
--    and are missing the LLM columns -- that is what caused
--    'column "custom_llm_base_url" does not exist'. Safe to re-run.
alter table public.broker_accounts add column if not exists ibkr_flex_token     text;
alter table public.broker_accounts add column if not exists ibkr_flex_query_id  text;
alter table public.broker_accounts add column if not exists telegram_chat_id    text;
alter table public.broker_accounts add column if not exists openai_api_key      text;
alter table public.broker_accounts add column if not exists gemini_api_key      text;
alter table public.broker_accounts add column if not exists anthropic_api_key   text;
alter table public.broker_accounts add column if not exists custom_llm_base_url text;
alter table public.broker_accounts add column if not exists custom_llm_api_key  text;
alter table public.broker_accounts add column if not exists custom_llm_model    text;
alter table public.broker_accounts add column if not exists llm_provider        text;
alter table public.broker_accounts add column if not exists updated_at          timestamptz not null default now();

-- 1. Status view: non-secret columns + existence flags, scoped to the caller.
--    (Runs with the view owner's rights so it can read the secret columns to
--    compute the flags; the WHERE clause is what limits it to the caller's own
--    row -- do not remove it.)
--    drop first: CREATE OR REPLACE VIEW can't change an existing view's columns.
drop view if exists public.broker_accounts_status;
create view public.broker_accounts_status as
select
  id,
  user_id,
  ibkr_flex_query_id,
  telegram_chat_id,
  custom_llm_base_url,
  custom_llm_model,
  llm_provider,
  updated_at,
  coalesce(ibkr_flex_token, '')      <> '' as has_ibkr_flex_token,
  coalesce(openai_api_key, '')       <> '' as has_openai_api_key,
  coalesce(gemini_api_key, '')       <> '' as has_gemini_api_key,
  coalesce(anthropic_api_key, '')    <> '' as has_anthropic_api_key,
  coalesce(custom_llm_api_key, '')   <> '' as has_custom_llm_api_key
from public.broker_accounts
where user_id = auth.uid();

revoke all on public.broker_accounts_status from anon, public;
grant select on public.broker_accounts_status to authenticated;

-- 2. Column-level lockdown on the base table: authenticated users keep SELECT
--    on non-secret columns only. INSERT/UPDATE grants are untouched, so saving
--    a key from the Settings page still works (existing RLS policies still
--    restrict writes to the user's own row).
revoke select on public.broker_accounts from anon, authenticated;
grant select (id, user_id, ibkr_flex_query_id, telegram_chat_id,
              custom_llm_base_url, custom_llm_model, llm_provider, updated_at)
  on public.broker_accounts to authenticated;

-- 3. Verify (run as a normal user via the API, not in the SQL editor):
--      select ibkr_flex_token from broker_accounts;   -- should now fail: permission denied
--      select * from broker_accounts_status;          -- your row, flags only

-- 4. Rollback if something breaks:
--      grant select on public.broker_accounts to authenticated;
--
-- Still worth doing afterwards (not done here): store the secrets encrypted
-- (Supabase Vault / pgsodium) instead of plaintext columns, and delete the
-- four LLM key columns if the backend never reads them (it currently only
-- reads ibkr_flex_token; AI routes use the server's own GEMINI_API_KEY).
