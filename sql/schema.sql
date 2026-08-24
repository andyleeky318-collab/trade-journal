-- Trade Journal Database Schema
-- Run this ONCE in Supabase SQL Editor (Dashboard > SQL Editor > New Query) on a
-- fresh project. It's idempotent (safe to re-run) via "if not exists" / "on
-- conflict do nothing" everywhere, so re-running it later to pick up a change
-- won't duplicate or break anything.

-- ========== MASTER (EDITABLE) LISTS ==========
-- Each user manages their own list of rules, emotions, market conditions, volatility types

create table if not exists rules_master (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz default now(),
  unique (user_id, name)
);

create table if not exists emotions_master (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz default now(),
  unique (user_id, name)
);

create table if not exists market_conditions_master (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz default now(),
  unique (user_id, name)
);

create table if not exists volatility_master (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz default now(),
  unique (user_id, name)
);

-- ========== DAILY JOURNAL ENTRY ==========

create table if not exists trading_days (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entry_date date not null,
  followed_rules boolean, -- null = not yet answered
  market_condition_id uuid references market_conditions_master(id) on delete set null,
  volatility_id uuid references volatility_master(id) on delete set null,
  notes text,
  improvements text,
  ai_summary text,

  -- Pre-Session Plan
  pre_max_loss numeric,
  pre_setups text,
  pre_mental_state text,
  pre_notes text,

  -- Post-Session Review (plan adherence)
  plan_followed boolean, -- null = not yet answered
  plan_deviation_notes text,

  -- Excludes this day from Journaling Consistency, same treatment as a
  -- market holiday, so time off doesn't count against the ratio.
  on_vacation boolean not null default false,

  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, entry_date)
);

-- Join table: which rule violations happened on a given day
create table if not exists day_violations (
  id uuid primary key default gen_random_uuid(),
  trading_day_id uuid not null references trading_days(id) on delete cascade,
  rule_id uuid not null references rules_master(id) on delete cascade,
  unique (trading_day_id, rule_id)
);

-- Join table: which emotions were felt on a given day
create table if not exists day_emotions (
  id uuid primary key default gen_random_uuid(),
  trading_day_id uuid not null references trading_days(id) on delete cascade,
  emotion_id uuid not null references emotions_master(id) on delete cascade,
  unique (trading_day_id, emotion_id)
);

-- Screenshots attached to a day (metadata; actual files live in Storage)
create table if not exists screenshots (
  id uuid primary key default gen_random_uuid(),
  trading_day_id uuid not null references trading_days(id) on delete cascade,
  storage_path text not null,
  created_at timestamptz default now()
);

-- Rollup summaries: AI-generated weekly/monthly synthesis of the period's
-- individual day entries + aggregate stats (adherence rate, top violations/emotions,
-- plan adherence). One row per (user, period_type, period_start).
create table if not exists rollup_summaries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  period_type text not null check (period_type in ('week', 'month')),
  period_start date not null, -- Sunday of the week (matches Calendar's week start), or the 1st of the month
  summary text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, period_type, period_start)
);

-- Market calendar reference data (weekends/holidays), synced from Alpaca by
-- the market-calendar-sync Edge Function. Not user-scoped — the same trading
-- calendar applies to everyone. See the setup guide's "Market calendar sync
-- (optional)" section; the app works fine without this table being populated,
-- it just falls back to flat calendar-day math for a few analytics views.
create table if not exists market_calendar_days (
  date date primary key,
  is_open boolean not null,
  open_time timestamptz,
  close_time timestamptz
);

-- ========== ROW LEVEL SECURITY ==========

alter table rules_master enable row level security;
alter table emotions_master enable row level security;
alter table market_conditions_master enable row level security;
alter table volatility_master enable row level security;
alter table trading_days enable row level security;
alter table day_violations enable row level security;
alter table day_emotions enable row level security;
alter table screenshots enable row level security;
alter table rollup_summaries enable row level security;
alter table market_calendar_days enable row level security;

-- Master lists: user can only see/edit their own
drop policy if exists "own rules" on rules_master;
create policy "own rules" on rules_master for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own emotions" on emotions_master;
create policy "own emotions" on emotions_master for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own market conditions" on market_conditions_master;
create policy "own market conditions" on market_conditions_master for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own volatility" on volatility_master;
create policy "own volatility" on volatility_master for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Trading days: user can only see/edit their own
drop policy if exists "own trading days" on trading_days;
create policy "own trading days" on trading_days for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Join tables: access controlled via parent trading_day's user_id
drop policy if exists "own day violations" on day_violations;
create policy "own day violations" on day_violations for all
  using (exists (select 1 from trading_days td where td.id = trading_day_id and td.user_id = auth.uid()))
  with check (exists (select 1 from trading_days td where td.id = trading_day_id and td.user_id = auth.uid()));

drop policy if exists "own day emotions" on day_emotions;
create policy "own day emotions" on day_emotions for all
  using (exists (select 1 from trading_days td where td.id = trading_day_id and td.user_id = auth.uid()))
  with check (exists (select 1 from trading_days td where td.id = trading_day_id and td.user_id = auth.uid()));

drop policy if exists "own screenshots" on screenshots;
create policy "own screenshots" on screenshots for all
  using (exists (select 1 from trading_days td where td.id = trading_day_id and td.user_id = auth.uid()))
  with check (exists (select 1 from trading_days td where td.id = trading_day_id and td.user_id = auth.uid()));

-- Rollup summaries: user can only see/edit their own
drop policy if exists "own rollup summaries" on rollup_summaries;
create policy "own rollup summaries" on rollup_summaries for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Market calendar: reference data, readable by any signed-in user; only the
-- market-calendar-sync Edge Function (using the service role key, which
-- bypasses RLS entirely) ever writes to it.
drop policy if exists "read market calendar" on market_calendar_days;
create policy "read market calendar" on market_calendar_days for select
  using (auth.role() = 'authenticated');

-- ========== STORAGE BUCKET FOR SCREENSHOTS ==========
-- Run this too (or create the bucket "screenshots" manually in Dashboard > Storage, set to Private)

insert into storage.buckets (id, name, public)
values ('screenshots', 'screenshots', false)
on conflict (id) do nothing;

drop policy if exists "own screenshot files read" on storage.objects;
create policy "own screenshot files read"
  on storage.objects for select
  using (bucket_id = 'screenshots' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "own screenshot files insert" on storage.objects;
create policy "own screenshot files insert"
  on storage.objects for insert
  with check (bucket_id = 'screenshots' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "own screenshot files delete" on storage.objects;
create policy "own screenshot files delete"
  on storage.objects for delete
  using (bucket_id = 'screenshots' and auth.uid()::text = (storage.foldername(name))[1]);

-- ========== SEED DEFAULT LISTS ==========
-- These insert starter values for the CURRENTLY LOGGED IN user (auth.uid()).
-- auth.uid() is only ever non-null when a request carries a signed-in user's
-- JWT (i.e. from inside the running app). Supabase's Dashboard SQL Editor
-- always runs as the postgres/service role with no such JWT, so auth.uid()
-- is null there no matter what — running this section from the SQL Editor,
-- signed in or not, will always skip it. The whole block is wrapped in an
-- auth.uid() check so it's a no-op (not an error) in that case, instead of
-- tripping the not-null user_id constraint. Add starter rules/emotions from
-- inside the app's "Manage list" screens instead, or run just this section
-- via a client that's actually authenticated as your app user. Feel free to
-- edit these lists to fit your own trading rules before running — they're
-- just a reasonable starting point.

do $$
begin
  if auth.uid() is null then
    raise notice 'Skipping SEED DEFAULT LISTS: no authenticated user (auth.uid() is null in this context).';
    return;
  end if;

  insert into emotions_master (user_id, name) values
    (auth.uid(), 'Confident'),
    (auth.uid(), 'Calm'),
    (auth.uid(), 'Focused'),
    (auth.uid(), 'Patient'),
    (auth.uid(), 'Disciplined'),
    (auth.uid(), 'Content'),
    (auth.uid(), 'Optimistic'),
    (auth.uid(), 'Curious'),
    (auth.uid(), 'Cautious'),
    (auth.uid(), 'Uncertain'),
    (auth.uid(), 'Bored'),
    (auth.uid(), 'Indifferent'),
    (auth.uid(), 'Hesitant'),
    (auth.uid(), 'Anxious'),
    (auth.uid(), 'Frustrated'),
    (auth.uid(), 'Impatient'),
    (auth.uid(), 'FOMO'),
    (auth.uid(), 'Greedy'),
    (auth.uid(), 'Overconfident'),
    (auth.uid(), 'Revenge-driven'),
    (auth.uid(), 'Fearful'),
    (auth.uid(), 'Regretful'),
    (auth.uid(), 'Panicked'),
    (auth.uid(), 'Angry'),
    (auth.uid(), 'Ashamed / Embarrassed'),
    (auth.uid(), 'Hopeless / Defeated')
  on conflict (user_id, name) do nothing;

  insert into market_conditions_master (user_id, name) values
    (auth.uid(), 'Strong Uptrend'),
    (auth.uid(), 'Strong Downtrend'),
    (auth.uid(), 'Range-bound / Choppy'),
    (auth.uid(), 'Breakout'),
    (auth.uid(), 'Reversal'),
    (auth.uid(), 'High Volatility / News-Driven'),
    (auth.uid(), 'Low Volume / Quiet')
  on conflict (user_id, name) do nothing;

  insert into rules_master (user_id, name) values
    (auth.uid(), 'Entered without a clear setup/signal'),
    (auth.uid(), 'Chased price (FOMO entry)'),
    (auth.uid(), 'No defined stop loss before entering'),
    (auth.uid(), 'Position size too large for the setup/conviction'),
    (auth.uid(), 'Entered against the higher-timeframe trend without justification'),
    (auth.uid(), 'Averaged into a losing position (revenge-added size)'),
    (auth.uid(), 'Risked more than planned % of account on a single trade'),
    (auth.uid(), 'Moved stop loss further away instead of honoring it'),
    (auth.uid(), 'No stop loss at all'),
    (auth.uid(), 'Over-leveraged / used too much margin'),
    (auth.uid(), 'Held through earnings/news without accounting for gap risk'),
    (auth.uid(), 'Exited winner too early out of fear'),
    (auth.uid(), 'Held loser too long hoping it would recover'),
    (auth.uid(), 'Moved profit target after it was hit (greed)'),
    (auth.uid(), 'Did not take partial profits at planned levels'),
    (auth.uid(), 'Revenge traded immediately after a loss'),
    (auth.uid(), 'Traded outside planned hours/session'),
    (auth.uid(), 'Traded a symbol not on the watchlist'),
    (auth.uid(), 'Skipped pre-market plan/checklist'),
    (auth.uid(), 'Overtraded (exceeded max trades per day)'),
    (auth.uid(), 'Traded while distracted, tired, or emotionally compromised'),
    (auth.uid(), 'Ignored a "no-trade day" rule')
  on conflict (user_id, name) do nothing;
end $$;
