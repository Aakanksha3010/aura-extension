-- Credit packs: one-time Razorpay payments that raise a user's try-on ceiling.
--
-- Deliberately NOT modelled on the `subscriptions` table. That table is
-- Stripe-shaped (stripe_customer_id, current_period_end) and describes a
-- recurring plan; a credit pack is a single purchase with no renewal, no
-- period, and no cancellation. Reusing it would mean carrying columns that
-- are permanently null and a status vocabulary that doesn't apply.

create table if not exists payments (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references profiles(id) on delete cascade,

  -- Razorpay's Payment Link id (plink_...). Unique because the paid webhook is
  -- delivered at least once and may be retried for days; this constraint is
  -- what makes credit granting idempotent rather than the handler's own logic.
  razorpay_payment_link_id text not null unique,
  razorpay_payment_id      text,          -- pay_... , only present once paid

  -- What was sold, captured at purchase time. Prices change; a historical row
  -- must still say what this user actually paid and received.
  pack_id                  text not null,
  credits                  integer not null check (credits > 0),
  amount_paise             integer not null check (amount_paise > 0),
  currency                 text not null default 'INR',

  status                   text not null default 'created'
                           check (status in ('created','paid','failed','expired','cancelled')),

  -- True only after try_on_limit has actually been raised. Separate from
  -- status='paid' on purpose: money received and credits granted are two
  -- different facts, and conflating them hides a partial failure.
  credits_granted_at       timestamptz,

  created_at               timestamptz default now(),
  paid_at                  timestamptz
);

create index if not exists payments_user_idx on payments (user_id, created_at desc);

alter table payments enable row level security;

-- Users may read their own payment history. No insert/update/delete policy
-- exists by design — rows are written only by the billing and webhook
-- functions via the service role, which bypasses RLS. A client that could
-- insert its own 'paid' row could grant itself credits.
drop policy if exists "own payments read" on payments;
create policy "own payments read" on payments
  for select using (auth.uid() = user_id);

-- Grants credits and marks the row, in one statement, exactly once.
--
-- The guard is `credits_granted_at is null` inside the UPDATE itself rather
-- than a read-then-write in the edge function: two concurrent webhook
-- deliveries would both pass a check-then-act and double-grant. Here the
-- second one updates zero rows and returns false.
--
-- security definer so it can raise try_on_limit regardless of the caller's
-- RLS context; search_path is pinned so the definer's rights can't be
-- redirected at a shadowed table.
create or replace function grant_pack_credits(
  p_payment_link_id text,
  p_razorpay_payment_id text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_credits integer;
begin
  update payments
     set status              = 'paid',
         razorpay_payment_id = coalesce(p_razorpay_payment_id, razorpay_payment_id),
         paid_at             = coalesce(paid_at, now()),
         credits_granted_at  = now()
   where razorpay_payment_link_id = p_payment_link_id
     and credits_granted_at is null
  returning user_id, credits into v_user_id, v_credits;

  if v_user_id is null then
    return false;   -- unknown link, or already granted
  end if;

  -- coalesce, because profiles.try_on_limit is NULLABLE (default 25, but the
  -- column permits NULL). NULL + credits = NULL, and the guard above has
  -- already stamped credits_granted_at — so the user would have paid, received
  -- nothing, and be permanently blocked from a retry. Unrecoverable without
  -- manual intervention.
  update profiles
     set try_on_limit = coalesce(try_on_limit, 0) + v_credits,
         updated_at   = now()
   where id = v_user_id;

  return true;
end;
$$;

revoke all on function grant_pack_credits(text, text) from public, anon, authenticated;
