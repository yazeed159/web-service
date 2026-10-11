-- 002_account_flex.sql  --  one IBKR Flex Query connection PER ACCOUNT
--
-- Run once in the Supabase SQL editor, AFTER 001_accounts.sql.
-- Safe to re-run.
--
-- Why: an IBKR paper account is a separate login from the live account, so
-- it has its own Flex Web Service token + Flex Query ID. Until now the site
-- stored ONE token per user (broker_accounts), which can't feed two accounts.
-- This table holds one connection per row in `accounts` (real or broker-paper).
--
-- Security model (same idea as broker_accounts_status):
--   * The token is WRITE-ONLY from the browser. The `authenticated` role has
--     no SELECT privilege on that column, so even a logged-in user's own
--     session cannot read it back. Only the service role (the daily sync)
--     can.
--   * The browser reads `account_flex_status`, which exposes a has_token
--     boolean instead of the token.

create table if not exists public.account_flex (
  account_id          uuid primary key references public.accounts(id) on delete cascade,
  user_id             uuid not null default auth.uid() references auth.users(id) on delete cascade,
  ibkr_flex_token     text,
  ibkr_flex_query_id  text,
  token_expires_on    date,          -- optional: when the token you generated expires
  ibkr_account_ref    text,          -- optional: expected IBKR account no. (DU... = paper). Lets the sync refuse a statement from the wrong account.
  last_sync_at        timestamptz,   -- written by the daily sync (service role)
  last_sync_status    text,          -- 'ok' | 'failed' | 'skipped'
  last_sync_message   text,
  updated_at          timestamptz not null default now()
);

create index if not exists account_flex_user_idx on public.account_flex(user_id);

alter table public.account_flex enable row level security;

-- Row access: your own rows, and only for accounts you can see
-- (accounts' own RLS makes the EXISTS subquery return only your accounts).
drop policy if exists "account_flex select own" on public.account_flex;
drop policy if exists "account_flex insert own" on public.account_flex;
drop policy if exists "account_flex update own" on public.account_flex;
drop policy if exists "account_flex delete own" on public.account_flex;

create policy "account_flex select own" on public.account_flex
  for select to authenticated using (user_id = auth.uid());

create policy "account_flex insert own" on public.account_flex
  for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.accounts a where a.id = account_id));

create policy "account_flex update own" on public.account_flex
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and exists (select 1 from public.accounts a where a.id = account_id));

create policy "account_flex delete own" on public.account_flex
  for delete to authenticated using (user_id = auth.uid());

-- Column privileges: token is write-only.
revoke all on public.account_flex from anon, authenticated;
grant select (account_id, user_id, ibkr_flex_query_id, token_expires_on, ibkr_account_ref,
              last_sync_at, last_sync_status, last_sync_message, updated_at)
  on public.account_flex to authenticated;
grant insert (account_id, user_id, ibkr_flex_token, ibkr_flex_query_id, token_expires_on,
              ibkr_account_ref, last_sync_at, last_sync_status, last_sync_message, updated_at)
  on public.account_flex to authenticated;
grant update (ibkr_flex_token, ibkr_flex_query_id, token_expires_on, ibkr_account_ref,
              last_sync_at, last_sync_status, last_sync_message, updated_at)
  on public.account_flex to authenticated;
grant delete on public.account_flex to authenticated;

-- What the site reads: everything except the token, plus has_ibkr_flex_token.
-- (Owner-run view with an explicit auth.uid() filter, because the caller has
-- no SELECT on the token column the boolean is computed from.)
create or replace view public.account_flex_status
with (security_barrier = true) as
select
  account_id,
  user_id,
  ibkr_flex_query_id,
  token_expires_on,
  ibkr_account_ref,
  last_sync_at,
  last_sync_status,
  last_sync_message,
  updated_at,
  (ibkr_flex_token is not null and ibkr_flex_token <> '') as has_ibkr_flex_token
from public.account_flex
where user_id = auth.uid();

revoke all on public.account_flex_status from anon;
grant select on public.account_flex_status to authenticated;

-- One-time carry-over: move the single token you already saved (Settings >
-- Integrations > IBKR Flex Query) onto the account the old sync was feeding.
-- If broker_accounts has an account_id, that account is used; otherwise your
-- oldest real account. CHECK THE RESULT on the Accounts page -- if that token
-- is really your PAPER login, move it (Disconnect, then connect on the paper
-- account). The old broker_accounts columns are left untouched.
insert into public.account_flex (account_id, user_id, ibkr_flex_token, ibkr_flex_query_id)
select account_id, user_id, ibkr_flex_token, ibkr_flex_query_id
from (
  select
    coalesce(
      nullif(to_jsonb(b)->>'account_id', '')::uuid,
      (select a.id from public.accounts a
         where a.user_id = b.user_id and a.kind = 'live'
         order by a.created_at asc limit 1)
    ) as account_id,
    b.user_id, b.ibkr_flex_token, b.ibkr_flex_query_id
  from public.broker_accounts b
  where b.ibkr_flex_token is not null and b.ibkr_flex_token <> ''
    and b.ibkr_flex_query_id is not null and b.ibkr_flex_query_id <> ''
) m
where account_id is not null
on conflict (account_id) do nothing;
