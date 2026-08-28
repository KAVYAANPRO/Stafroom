-- Staffroom schema for Supabase/Postgres.
-- Run this once in the Supabase SQL Editor (Project → SQL Editor → New query → paste → Run).
--
-- Auth is handled entirely by Supabase (auth.users). `profiles` holds the
-- app-specific fields for each teacher and is auto-created by a trigger the
-- moment someone signs up. Every other table carries `user_id` and is locked
-- down with Row-Level Security so a teacher can only ever see their own rows
-- — enforced by Postgres itself, not just application code.

create extension if not exists "pgcrypto";

-- ------------------------------------------------------------------ profiles
create table if not exists profiles (
  id               uuid primary key references auth.users(id) on delete cascade,
  name             text not null default '',
  email            text not null default '',
  phone            text,
  school           text not null default '',
  plan             text not null default 'Free',            -- Free | Pro | Max
  billing_period   text not null default 'monthly',         -- monthly | annual
  credits          numeric not null default 100,
  allowance        numeric not null default 100,
  credits_reset_on timestamptz,
  boards           jsonb not null default '["CBSE"]',
  grades           jsonb not null default '[]',
  subjects         jsonb not null default '[]',
  medium           text not null default 'English',
  difficulty       text not null default 'Balanced',
  question_mix     text not null default 'Short-answer heavy',
  lang             text not null default 'English',
  notifications    jsonb not null default '{"evalDone":true,"lowCredit":true,"weekly":false}',
  created_at       timestamptz not null default now()
);

alter table profiles enable row level security;
create policy "profiles: self select" on profiles for select using (id = auth.uid());
create policy "profiles: self update" on profiles for update using (id = auth.uid());
-- Insert happens via the trigger below (security definer), not directly by users.

-- Auto-create a profile the moment someone signs up via Supabase Auth.
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, name, email, credits_reset_on)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    new.email,
    date_trunc('month', now()) + interval '1 month'
  );
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- -------------------------------------------------------------------classes
create table if not exists classes (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  key           text not null,
  board         text not null default 'CBSE',
  grade         text not null,
  section       text,
  subject       text not null,
  student_count integer not null default 0,
  syllabus      text not null default '2026-27',
  medium        text not null default 'English',
  question_mix  text not null default 'Short-answer heavy',
  archived      boolean not null default false,
  created_at    timestamptz not null default now(),
  unique (user_id, key)
);
alter table classes enable row level security;
create policy "classes: owner all" on classes for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ------------------------------------------------------------------chapters
create table if not exists chapters (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  class_id    uuid not null references classes(id) on delete cascade,
  name        text not null,
  topic_count integer not null default 0,
  position    integer not null default 0
);
alter table chapters enable row level security;
create policy "chapters: owner all" on chapters for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ------------------------------------------------------------------students
create table if not exists students (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  class_id   uuid not null references classes(id) on delete cascade,
  name       text not null,
  roll_no    integer,
  created_at timestamptz not null default now()
);
alter table students enable row level security;
create policy "students: owner all" on students for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- -----------------------------------------------------------------questions
create table if not exists questions (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  class_id       uuid references classes(id) on delete set null,
  grade          text,
  subject        text,
  chapter        text not null,
  topic          text,
  type           text not null default 'Short',      -- MCQ | Short | Long
  marks          integer not null default 1,
  difficulty     text not null default 'Medium',     -- Easy | Medium | Hard
  medium         text not null default 'English',
  text           text not null,
  answer         text not null default '',
  variant_text   text,
  variant_answer text,
  source         text not null default 'ai',         -- ai | manual | imported | evaluation
  favorite       boolean not null default false,
  shortlisted    boolean not null default false,
  created_at     timestamptz not null default now()
);
create index if not exists idx_questions_user on questions(user_id, chapter, type, difficulty);
alter table questions enable row level security;
create policy "questions: owner all" on questions for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------assessments
create table if not exists assessments (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  class_id      uuid references classes(id) on delete set null,
  title         text not null,
  subject       text,
  total_marks   integer not null default 25,
  duration      text,
  blueprint     text,
  difficulty    text not null default 'Balanced',
  medium        text not null default 'English',
  chapters      jsonb not null default '[]',
  instructions  jsonb not null default '[]',
  status        text not null default 'Draft',       -- Draft | Finalized | Distributed | Evaluated
  scheduled_for timestamptz,
  generated_by  text not null default 'offline',      -- gemini | offline
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table assessments enable row level security;
create policy "assessments: owner all" on assessments for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ------------------------------------------------------- assessment_questions
create table if not exists assessment_questions (
  id             uuid primary key default gen_random_uuid(),
  assessment_id  uuid not null references assessments(id) on delete cascade,
  question_id    uuid references questions(id) on delete set null,
  section        text not null default 'A',
  position       integer not null,
  marks          integer not null default 1,
  topic          text,
  difficulty     text,
  text           text not null,
  answer         text not null default '',
  variant_text   text,
  variant_answer text,
  using_variant  boolean not null default false
);
create index if not exists idx_aq_assessment on assessment_questions(assessment_id, position);
alter table assessment_questions enable row level security;
-- Scoped through the parent assessment's ownership (this table has no user_id of its own).
create policy "assessment_questions: owner all" on assessment_questions for all
  using (exists (select 1 from assessments a where a.id = assessment_id and a.user_id = auth.uid()))
  with check (exists (select 1 from assessments a where a.id = assessment_id and a.user_id = auth.uid()));

-- -------------------------------------------------------------------results
create table if not exists results (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  assessment_id uuid not null references assessments(id) on delete cascade,
  student_id    uuid not null references students(id) on delete cascade,
  score         numeric not null default 0,
  max_score     numeric not null default 0,
  ai_confidence numeric,
  needs_review  boolean not null default false,
  reviewed      boolean not null default false,
  evaluated_at  timestamptz not null default now(),
  unique (assessment_id, student_id)
);
alter table results enable row level security;
create policy "results: owner all" on results for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- --------------------------------------------------------------- result_items
create table if not exists result_items (
  id         uuid primary key default gen_random_uuid(),
  result_id  uuid not null references results(id) on delete cascade,
  aq_id      uuid references assessment_questions(id) on delete cascade,
  topic      text,
  chapter    text,
  awarded    numeric not null default 0,
  max_marks  numeric not null default 0,
  comment    text,
  confidence numeric
);
create index if not exists idx_result_items on result_items(result_id);
alter table result_items enable row level security;
create policy "result_items: owner all" on result_items for all
  using (exists (select 1 from results r where r.id = result_id and r.user_id = auth.uid()))
  with check (exists (select 1 from results r where r.id = result_id and r.user_id = auth.uid()));

-- --------------------------------------------------------------weak_concepts
create table if not exists weak_concepts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  class_id    uuid not null references classes(id) on delete cascade,
  concept     text not null,
  severity    text not null default 'Medium',       -- High | Medium
  trend       text not null default '',
  score_pct   numeric,
  sample_size integer not null default 0,
  resolved    boolean not null default false,
  detected_at timestamptz not null default now(),
  unique (user_id, class_id, concept)
);
alter table weak_concepts enable row level security;
create policy "weak_concepts: owner all" on weak_concepts for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- -----------------------------------------------------------------materials
create table if not exists materials (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  class_id       uuid references classes(id) on delete set null,
  student_id     uuid references students(id) on delete set null,
  type           text not null,                        -- NOTES | WORKSHEET | QUIZ | LESSON PLAN
  title          text not null,
  chapter        text default '',
  concept        text,
  chapters       jsonb not null default '[]',           -- Note Maker: full chapter list (single-chapter Materials leave this empty)
  body           text not null default '',
  reference_text text,                                  -- Note Maker: extracted text from a teacher-uploaded reference file, if any
  used_analytics boolean not null default false,         -- Note Maker: whether class/student weak-concept data informed this note
  generated_by   text not null default 'offline',
  created_at     timestamptz not null default now()
);
alter table materials enable row level security;
create policy "materials: owner all" on materials for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Note Maker additions — run these ALTERs manually in the Supabase SQL editor
-- against the existing production `materials` table (the CREATE above only
-- applies to a fresh install, since it's `if not exists`).
alter table materials add column if not exists student_id uuid references students(id) on delete set null;
alter table materials add column if not exists chapters jsonb not null default '[]';
alter table materials add column if not exists reference_text text;
alter table materials add column if not exists used_analytics boolean not null default false;

-- ------------------------------------------------------------- credit_ledger
create table if not exists credit_ledger (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  action        text not null,
  detail        text not null default '',
  delta         numeric not null,
  balance_after numeric not null,
  created_at    timestamptz not null default now()
);
create index if not exists idx_ledger_user on credit_ledger(user_id, created_at desc);
alter table credit_ledger enable row level security;
create policy "credit_ledger: owner all" on credit_ledger for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ------------------------------------------------------------ payment_orders
-- One row per Razorpay order. Written only by the server (admin client) —
-- the checkout endpoint creates it before the user ever sees the payment
-- widget, and the verify endpoint flips it to 'paid' only after checking the
-- HMAC signature. This is what lets /billing/verify be idempotent (a replay
-- of the same order can't double-credit) and lets it recall what the order
-- was actually FOR, since Razorpay itself doesn't know about credit packs.
create table if not exists payment_orders (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  razorpay_order_id text not null unique,
  kind              text not null,              -- topup | plan
  pack_id           text,                        -- set when kind = topup
  plan              text,                        -- set when kind = plan
  billing_period    text,                        -- set when kind = plan
  amount_paise      integer not null,
  status            text not null default 'created', -- created | paid | failed
  created_at        timestamptz not null default now(),
  paid_at           timestamptz
);
alter table payment_orders enable row level security;
create policy "payment_orders: owner select" on payment_orders for select using (user_id = auth.uid());
-- No insert/update policy — rows are only ever written by the server's admin client.

-- --------------------------------------------------------- credit RPC functions
-- Plain UPDATE-then-INSERT from the JS client can race under concurrent
-- requests (two tabs generating papers at once, etc). These run the whole
-- read-modify-write inside one Postgres transaction with a row lock, so the
-- balance and ledger always stay consistent.

create or replace function spend_credits(p_amount numeric, p_action text, p_detail text default '')
returns table(balance numeric, spent numeric) as $$
declare
  v_credits numeric;
  v_balance numeric;
begin
  if p_amount < 0 then
    raise exception 'INVALID_AMOUNT';
  end if;
  select credits into v_credits from profiles where id = auth.uid() for update;
  if v_credits is null then
    raise exception 'UNKNOWN_USER';
  end if;
  if v_credits < p_amount then
    raise exception 'INSUFFICIENT_CREDITS:%:%', p_amount, v_credits;
  end if;
  v_balance := round(v_credits - p_amount, 2);
  update profiles set credits = v_balance where id = auth.uid();
  if p_amount > 0 then
    insert into credit_ledger (user_id, action, detail, delta, balance_after)
    values (auth.uid(), p_action, p_detail, -p_amount, v_balance);
  end if;
  return query select v_balance, p_amount;
end;
$$ language plpgsql security definer set search_path = public;

create or replace function grant_credits(p_amount numeric, p_action text, p_detail text default '')
returns table(balance numeric) as $$
declare
  v_balance numeric;
begin
  update profiles set credits = round(credits + p_amount, 2) where id = auth.uid()
    returning credits into v_balance;
  if v_balance is null then
    raise exception 'UNKNOWN_USER';
  end if;
  insert into credit_ledger (user_id, action, detail, delta, balance_after)
  values (auth.uid(), p_action, p_detail, p_amount, v_balance);
  return query select v_balance;
end;
$$ language plpgsql security definer set search_path = public;

-- Refills the monthly allowance in-place when the reset date has passed —
-- called at the top of every authenticated request (see attachUser).
create or replace function apply_monthly_reset()
returns profiles as $$
declare
  v_profile profiles;
  v_plan_credits numeric;
  v_next timestamptz;
begin
  select * into v_profile from profiles where id = auth.uid() for update;
  if v_profile.credits_reset_on is null or v_profile.credits_reset_on > now() then
    return v_profile;
  end if;
  v_plan_credits := case v_profile.plan when 'Pro' then 600 when 'Max' then 2500 else 100 end;
  v_next := date_trunc('month', now()) + interval '1 month';
  update profiles set credits = v_plan_credits, allowance = v_plan_credits, credits_reset_on = v_next
    where id = auth.uid() returning * into v_profile;
  insert into credit_ledger (user_id, action, detail, delta, balance_after)
  values (auth.uid(), 'Monthly allowance', v_profile.plan || ' plan refill', v_plan_credits, v_plan_credits);
  return v_profile;
end;
$$ language plpgsql security definer set search_path = public;

-- =============================================================================
-- MIGRATION (2026-08-28): grace overage on credit spending
-- -----------------------------------------------------------------------------
-- NOT applied automatically — this repo has no DB connection/credentials to
-- run it against Supabase. Paste this block into the Supabase SQL Editor
-- (Project -> SQL Editor -> New query -> paste -> Run) once, manually.
--
-- Both functions below use `create or replace`, so they simply supersede the
-- spend_credits / apply_monthly_reset definitions further up this file —
-- running the whole file top-to-bottom (e.g. on a fresh install) is safe
-- too, since this block runs last and wins.
--
-- What this changes: today spend_credits hard-blocks any spend that would
-- take the balance below zero, and both apply_monthly_reset and
-- applyPlanSwitch (src/routes/billing.js) blindly SET credits to the new
-- plan's allowance, wiping out any balance that was there. This migration:
--
--   1. Lets spend_credits allow a small "grace overage" — the balance may go
--      negative, like Claude/OpenAI usage-based overage, but only down to
--      -1 * greatest(p_amount, 20) (at most one action's worth of debt,
--      floored at -20 so a cheap action can't be chained into a big hole).
--      Only a spend that would cross that floor still raises
--      INSUFFICIENT_CREDITS.
--   2. Makes apply_monthly_reset settle a negative balance against the
--      fresh monthly allowance instead of overwriting it: new_balance =
--      greatest(plan_credits + old_credits, 0) when old_credits < 0 (old
--      debt is subtracted from the refill), otherwise the refill is applied
--      as before.
--
-- The equivalent settle-instead-of-overwrite fix for plan switches lives in
-- application code (applyPlanSwitch in src/routes/billing.js), since that
-- path is a plain Supabase `.update()`, not an RPC — it isn't part of this
-- SQL migration. grant_credits (top-ups) needed NO change: it already does
-- `credits + p_amount`, so a top-up added to a negative balance naturally
-- pays the debt down (or off) as part of the same addition.
--
-- Scope/honesty note: there is no Razorpay auto-charge or subscription-
-- mandate wiring in this codebase, so "billed with the next payment" here
-- means the debt is deducted from the next monthly allowance refill or the
-- next top-up purchase — NOT an automatic real-money charge taken from the
-- teacher without them acting.
-- =============================================================================

create or replace function spend_credits(p_amount numeric, p_action text, p_detail text default '')
returns table(balance numeric, spent numeric) as $$
declare
  v_credits numeric;
  v_balance numeric;
  v_floor numeric;
begin
  if p_amount < 0 then
    raise exception 'INVALID_AMOUNT';
  end if;
  select credits into v_credits from profiles where id = auth.uid() for update;
  if v_credits is null then
    raise exception 'UNKNOWN_USER';
  end if;
  -- Grace overage floor: allow the balance to dip into the red by at most
  -- one action's cost, never lower than -20 credits. A teacher with 3
  -- credits left triggering a 6-credit paper goes to -3 and the action
  -- still goes through; someone already sitting at/near the floor gets
  -- blocked once the next spend would cross it.
  v_floor := -1 * greatest(p_amount, 20);
  v_balance := round(v_credits - p_amount, 2);
  if v_balance < v_floor then
    raise exception 'INSUFFICIENT_CREDITS:%:%', p_amount, v_credits;
  end if;
  update profiles set credits = v_balance where id = auth.uid();
  if p_amount > 0 then
    insert into credit_ledger (user_id, action, detail, delta, balance_after)
    values (auth.uid(), p_action, p_detail, -p_amount, v_balance);
  end if;
  return query select v_balance, p_amount;
end;
$$ language plpgsql security definer set search_path = public;

create or replace function apply_monthly_reset()
returns profiles as $$
declare
  v_profile profiles;
  v_plan_credits numeric;
  v_next timestamptz;
  v_old_credits numeric;
  v_new_balance numeric;
begin
  select * into v_profile from profiles where id = auth.uid() for update;
  if v_profile.credits_reset_on is null or v_profile.credits_reset_on > now() then
    return v_profile;
  end if;
  v_old_credits := v_profile.credits;
  v_plan_credits := case v_profile.plan when 'Pro' then 600 when 'Max' then 2500 else 100 end;
  v_next := date_trunc('month', now()) + interval '1 month';
  -- Settle grace-overage debt out of the fresh allowance instead of wiping
  -- it: a negative old balance is debt owed, so it's subtracted from the
  -- new allowance (floored at 0 — debt never carries across two resets).
  v_new_balance := case when v_old_credits < 0 then greatest(v_plan_credits + v_old_credits, 0) else v_plan_credits end;
  update profiles set credits = v_new_balance, allowance = v_plan_credits, credits_reset_on = v_next
    where id = auth.uid() returning * into v_profile;
  insert into credit_ledger (user_id, action, detail, delta, balance_after)
  values (
    auth.uid(), 'Monthly allowance',
    case when v_old_credits < 0
      then v_profile.plan || ' plan refill (settled ' || (-v_old_credits) || ' overage debt)'
      else v_profile.plan || ' plan refill'
    end,
    v_new_balance - v_old_credits, v_new_balance
  );
  return v_profile;
end;
$$ language plpgsql security definer set search_path = public;
