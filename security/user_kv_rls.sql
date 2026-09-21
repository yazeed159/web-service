-- user_kv row-level security -- run in the Supabase SQL editor.
-- user_kv holds your star grades, journal entries, daily notes and other
-- per-user settings (see auth.js KV). Without these policies another logged-in
-- user could read or overwrite your rows. Safe to re-run.

alter table public.user_kv enable row level security;

drop policy if exists "kv select own" on public.user_kv;
drop policy if exists "kv insert own" on public.user_kv;
drop policy if exists "kv update own" on public.user_kv;
drop policy if exists "kv delete own" on public.user_kv;

create policy "kv select own" on public.user_kv for select using (auth.uid() = user_id);
create policy "kv insert own" on public.user_kv for insert with check (auth.uid() = user_id);
create policy "kv update own" on public.user_kv for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "kv delete own" on public.user_kv for delete using (auth.uid() = user_id);

-- The app upserts on (user_id, key), so that pair must be unique:
create unique index if not exists user_kv_user_key_idx on public.user_kv (user_id, key);

-- Check what is currently in place (run before/after):
--   select policyname, cmd, qual from pg_policies where tablename = 'user_kv';
--   select relrowsecurity from pg_class where relname = 'user_kv';
